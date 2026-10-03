// The board repo on disk: every board is read into memory at start, kept current by a
// recursive watch on the repo (so a Claude session editing a card file moves it on screen),
// and every write goes through here.

import { promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { between, cardNumber, parseCard, serializeCard, slugify, sortCards } from '@shared/cardfile'
import type {
  BoardDelta,
  BoardMap,
  BoardMeta,
  BoardNode,
  Card,
  CardPatch,
  LoadedBoard,
} from '@shared/types'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'cards'])
const DEFAULT_LISTS = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'Doing' },
  { id: 'done', title: 'Done' },
]

export type StoreEvents = {
  onDelta: (delta: BoardDelta) => void
  onTreeChanged: () => void
}

export class BoardStore {
  readonly root: string
  private boards = new Map<string, LoadedBoard>()
  /** Last text read or written per absolute file path: a watch event that changes nothing is dropped. */
  private texts = new Map<string, string>()
  private watcher?: FSWatcher
  private pending = new Set<string>()
  private flushTimer?: NodeJS.Timeout
  private events?: StoreEvents

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  // ---- reading -------------------------------------------------------------------------------

  async init(): Promise<void> {
    this.boards.clear()
    this.texts.clear()
    for (const boardPath of await this.findBoards('')) await this.readBoard(boardPath)
    this.resolveInheritance()
  }

  private async findBoards(rel: string): Promise<string[]> {
    const abs = path.join(this.root, rel)
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      return []
    }
    const found: string[] = []
    if (rel && entries.some(e => e.isFile() && e.name === 'board.json')) found.push(rel)
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      found.push(...(await this.findBoards(rel ? `${rel}/${entry.name}` : entry.name)))
    }
    return found
  }

  private async readBoard(boardPath: string): Promise<LoadedBoard | undefined> {
    const meta = await this.readJson<BoardMeta>(this.metaFile(boardPath))
    if (!meta) return undefined
    meta.lists ??= []
    const map = (await this.readJson<BoardMap>(this.mapFile(boardPath))) ?? { nodes: {} }
    map.nodes ??= {}
    const cards: Card[] = []
    const cardsDir = path.join(this.root, boardPath, 'cards')
    let names: string[] = []
    try {
      names = await fs.readdir(cardsDir)
    } catch {
      /* a board with no cards yet */
    }
    await Promise.all(
      names
        .filter(n => n.endsWith('.md'))
        .map(async name => {
          const card = await this.readCardFile(path.join(cardsDir, name))
          if (card) cards.push(card)
        }),
    )
    const board: LoadedBoard = { path: boardPath, meta, cards: sortCards(cards), map }
    this.boards.set(boardPath, board)
    return board
  }

  private async readCardFile(abs: string): Promise<Card | undefined> {
    try {
      const text = await fs.readFile(abs, 'utf8')
      this.texts.set(abs, text)
      return parseCard(text, path.basename(abs, '.md'))
    } catch {
      return undefined
    }
  }

  private async readJson<T>(abs: string): Promise<T | undefined> {
    try {
      const text = await fs.readFile(abs, 'utf8')
      this.texts.set(abs, text)
      return JSON.parse(text) as T
    } catch {
      return undefined
    }
  }

  /** codeRepo comes down from the nearest ancestor that sets it. */
  private resolveInheritance(): void {
    for (const board of this.boards.values()) {
      let at: string | undefined = board.path
      board.codeRepo = undefined
      while (at !== undefined) {
        const repo = this.boards.get(at)?.meta.codeRepo
        if (repo) {
          board.codeRepo = repo
          break
        }
        at = parentPath(at)
      }
    }
  }

  tree(): BoardNode[] {
    const nodes = new Map<string, BoardNode>()
    const paths = [...this.boards.keys()].sort()
    for (const p of paths) {
      const b = this.boards.get(p)!
      nodes.set(p, {
        path: p,
        title: b.meta.title,
        key: b.meta.key,
        listCount: b.meta.lists.length,
        cardCount: b.cards.filter(c => !c.archived).length,
        children: [],
      })
    }
    const roots: BoardNode[] = []
    for (const p of paths) {
      let parent = parentPath(p)
      while (parent !== undefined && !nodes.has(parent)) parent = parentPath(parent)
      if (parent === undefined) roots.push(nodes.get(p)!)
      else nodes.get(parent)!.children.push(nodes.get(p)!)
    }
    const order = (list: BoardNode[]) => {
      list.sort((a, b) => a.title.localeCompare(b.title))
      list.forEach(n => order(n.children))
    }
    order(roots)
    return roots
  }

  board(boardPath: string): LoadedBoard {
    const board = this.boards.get(boardPath)
    if (!board) throw new Error(`No board at ${boardPath}`)
    return board
  }

  allBoards(): LoadedBoard[] {
    return [...this.boards.values()]
  }

  /** The board and card for an id anywhere in the repo. */
  findCard(id: string): { board: LoadedBoard; card: Card } | undefined {
    for (const board of this.boards.values()) {
      const card = board.cards.find(c => c.id === id)
      if (card) return { board, card }
    }
    return undefined
  }

  cardFile(boardPath: string, id: string): string {
    return path.join(this.root, boardPath, 'cards', `${id}.md`)
  }

  private metaFile(boardPath: string): string {
    return path.join(this.root, boardPath, 'board.json')
  }

  private mapFile(boardPath: string): string {
    return path.join(this.root, boardPath, 'map.json')
  }

  // ---- writing -------------------------------------------------------------------------------

  async createBoard(parent: string, title: string, key?: string): Promise<string> {
    const cleanTitle = title.trim() || 'Untitled board'
    const base = slugify(cleanTitle)
    let dir = parent ? `${parent}/${base}` : base
    for (let n = 2; this.boards.has(dir) || (await exists(path.join(this.root, dir))); n++) {
      dir = parent ? `${parent}/${base}-${n}` : `${base}-${n}`
    }
    const meta: BoardMeta = {
      key: this.uniqueKey(key?.trim().toUpperCase() || deriveKey(cleanTitle)),
      title: cleanTitle,
      lists: DEFAULT_LISTS.map(l => ({ ...l })),
      flow: { doing: 'doing', done: 'done' },
      created: new Date().toISOString(),
    }
    await fs.mkdir(path.join(this.root, dir, 'cards'), { recursive: true })
    await this.writeText(this.metaFile(dir), formatJson(meta))
    this.boards.set(dir, { path: dir, meta, cards: [], map: { nodes: {} } })
    this.resolveInheritance()
    this.events?.onTreeChanged()
    return dir
  }

  uniqueKey(wanted: string): string {
    const taken = new Set([...this.boards.values()].map(b => b.meta.key))
    const clean = wanted.replace(/[^A-Z0-9]/g, '') || 'B'
    if (!taken.has(clean)) return clean
    for (let n = 2; ; n++) if (!taken.has(`${clean}${n}`)) return `${clean}${n}`
  }

  async updateMeta(boardPath: string, patch: Partial<BoardMeta>): Promise<BoardMeta> {
    const board = this.board(boardPath)
    const meta: BoardMeta = { ...board.meta, ...patch, key: board.meta.key }
    for (const [k, v] of Object.entries(meta)) if (v === undefined || v === '') delete (meta as any)[k]
    board.meta = meta
    await this.writeText(this.metaFile(boardPath), formatJson(meta))
    this.resolveInheritance()
    this.events?.onTreeChanged()
    return meta
  }

  /** Removes a board folder that holds no cards and no child boards. */
  async deleteBoard(boardPath: string): Promise<void> {
    const board = this.board(boardPath)
    if (board.cards.length) throw new Error('The board still has cards; archive or move them first.')
    if ([...this.boards.keys()].some(p => p.startsWith(`${boardPath}/`)))
      throw new Error('The board still has child boards.')
    await fs.rm(path.join(this.root, boardPath), { recursive: true })
    this.boards.delete(boardPath)
    this.events?.onTreeChanged()
  }

  async createCard(
    boardPath: string,
    fields: { title: string; list: string | null; pos?: number; body?: string; links?: string[] },
  ): Promise<Card> {
    const board = this.board(boardPath)
    const next =
      Math.max(0, ...board.cards.map(c => cardNumber(c.id)).filter(n => Number.isFinite(n))) + 1
    const inList = sortCards(board.cards.filter(c => c.list === fields.list && !c.archived))
    const card: Card = {
      id: `${board.meta.key}-${next}`,
      title: fields.title.trim() || 'Untitled',
      list: fields.list,
      pos: fields.pos ?? between(inList.at(-1)?.pos, undefined),
      created: new Date().toISOString(),
      labels: [],
      links: fields.links ?? [],
      sessions: [],
      body: fields.body ?? '',
      extra: {},
    }
    await this.writeCard(boardPath, card)
    return card
  }

  async updateCard(boardPath: string, id: string, patch: CardPatch): Promise<Card> {
    const board = this.board(boardPath)
    const current = board.cards.find(c => c.id === id)
    if (!current) throw new Error(`No card ${id} on ${boardPath}`)
    const card: Card = { ...current, ...patch, updated: new Date().toISOString() }
    await this.writeCard(boardPath, card)
    return card
  }

  async saveMap(boardPath: string, map: BoardMap): Promise<void> {
    const board = this.board(boardPath)
    const nodes: BoardMap['nodes'] = {}
    for (const id of Object.keys(map.nodes).sort((a, b) => cardNumber(a) - cardNumber(b))) {
      nodes[id] = { x: Math.round(map.nodes[id].x), y: Math.round(map.nodes[id].y) }
    }
    board.map = { ...map, nodes }
    await this.writeText(this.mapFile(boardPath), formatJson(board.map))
  }

  private async writeCard(boardPath: string, card: Card): Promise<void> {
    const board = this.board(boardPath)
    await fs.mkdir(path.join(this.root, boardPath, 'cards'), { recursive: true })
    await this.writeText(this.cardFile(boardPath, card.id), serializeCard(card))
    board.cards = sortCards([...board.cards.filter(c => c.id !== card.id), card])
    this.events?.onDelta({ path: boardPath, cards: [card], removed: [] })
  }

  /** Write-then-rename, so a reader (the watch, a Claude session) never sees half a file. */
  private async writeText(abs: string, text: string): Promise<void> {
    this.texts.set(abs, text)
    const tmp = `${abs}.${process.pid}.tmp`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, abs)
  }

  // ---- watching ------------------------------------------------------------------------------

  watch(events: StoreEvents): void {
    this.events = events
    this.watcher?.close()
    this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const rel = filename.toString().split(path.sep).join('/')
      if (rel.startsWith('.git/') || rel === '.git' || rel.endsWith('.tmp')) return
      this.pending.add(rel)
      clearTimeout(this.flushTimer)
      this.flushTimer = setTimeout(() => void this.flush(), 80)
    })
  }

  close(): void {
    this.watcher?.close()
    clearTimeout(this.flushTimer)
  }

  private async flush(): Promise<void> {
    const changed = [...this.pending]
    this.pending.clear()
    const deltas = new Map<string, BoardDelta>()
    const delta = (p: string) => {
      let d = deltas.get(p)
      if (!d) deltas.set(p, (d = { path: p, cards: [], removed: [] }))
      return d
    }
    let treeChanged = false

    for (const rel of changed) {
      const abs = path.join(this.root, rel)
      const parts = rel.split('/')
      const name = parts.at(-1)!
      if (name === 'board.json') {
        const boardPath = parts.slice(0, -1).join('/')
        const text = await readOrUndefined(abs)
        if (text === undefined) {
          if (this.boards.delete(boardPath)) treeChanged = true
          continue
        }
        if (this.texts.get(abs) === text) continue
        this.texts.set(abs, text)
        if (!this.boards.has(boardPath)) {
          await this.readBoard(boardPath)
          treeChanged = true
          continue
        }
        try {
          const meta = JSON.parse(text) as BoardMeta
          meta.lists ??= []
          this.board(boardPath).meta = meta
          delta(boardPath).meta = meta
          treeChanged = true
        } catch {
          /* a half-saved hand edit: wait for the next save */
        }
      } else if (name === 'map.json') {
        const boardPath = parts.slice(0, -1).join('/')
        const board = this.boards.get(boardPath)
        const text = await readOrUndefined(abs)
        if (!board || text === undefined || this.texts.get(abs) === text) continue
        this.texts.set(abs, text)
        try {
          board.map = JSON.parse(text) as BoardMap
          board.map.nodes ??= {}
          delta(boardPath).map = board.map
        } catch {
          /* ignore until valid */
        }
      } else if (name.endsWith('.md') && parts.at(-2) === 'cards') {
        const boardPath = parts.slice(0, -2).join('/')
        const board = this.boards.get(boardPath)
        if (!board) continue
        const id = name.slice(0, -3)
        const text = await readOrUndefined(abs)
        if (text === undefined) {
          this.texts.delete(abs)
          if (board.cards.some(c => c.id === id)) {
            board.cards = board.cards.filter(c => c.id !== id)
            delta(boardPath).removed.push(id)
            treeChanged = true
          }
          continue
        }
        if (this.texts.get(abs) === text) continue
        this.texts.set(abs, text)
        const card = parseCard(text, id)
        const isNew = !board.cards.some(c => c.id === card.id)
        board.cards = sortCards([...board.cards.filter(c => c.id !== card.id), card])
        delta(boardPath).cards.push(card)
        if (isNew) treeChanged = true
      } else if (!name.includes('.')) {
        // A folder appeared or went away: maybe a whole board (git checkout, a copy).
        const before = new Set(this.boards.keys())
        const now = new Set(await this.findBoards(''))
        for (const p of now) if (!before.has(p)) await this.readBoard(p)
        for (const p of before) if (!now.has(p)) this.boards.delete(p)
        if (now.size !== before.size || [...now].some(p => !before.has(p))) treeChanged = true
      }
    }

    if (treeChanged) this.resolveInheritance()
    for (const d of deltas.values()) this.events?.onDelta(d)
    if (treeChanged) this.events?.onTreeChanged()
  }
}

export function parentPath(p: string): string | undefined {
  if (!p) return undefined
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

export function deriveKey(title: string): string {
  const words = title
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length >= 2) return words.map(w => w[0]).join('').slice(0, 4)
  return (words[0] ?? 'B').slice(0, 4)
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function readOrUndefined(abs: string): Promise<string | undefined> {
  try {
    return await fs.readFile(abs, 'utf8')
  } catch {
    return undefined
  }
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs)
    return true
  } catch {
    return false
  }
}
