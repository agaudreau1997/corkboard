// The board repo on disk: every board (and the project's theme.json) is read into memory at
// start, kept current by a recursive watch on the repo (so a Claude session editing a card file
// moves it on screen), and every write goes through here.

import { existsSync, promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { between, cardNumber, parseCard, serializeCard, slugify, sortCards, tryParseCard } from '@shared/cardfile'
import { isEmptyTheme, parseTheme, THEME_FILE, themeText } from '@shared/theme'
import type {
  BoardDelta,
  BoardMap,
  BoardMeta,
  BoardNode,
  Card,
  CardPatch,
  LoadedBoard,
  ProjectTheme,
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
  /** The project's colours (`theme.json` at the root), when it has any. */
  theme?: ProjectTheme
  private boards = new Map<string, LoadedBoard>()
  /** Last text read or written per absolute file path: a watch event that changes nothing is dropped. */
  private texts = new Map<string, string>()
  /** One non-recursive watch per folder that matters: the root, each board and its cards. */
  private watchers = new Map<string, FSWatcher>()
  private pending = new Set<string>()
  private flushTimer?: NodeJS.Timeout
  private events?: StoreEvents
  /** This machine's own code repo paths, by board path (app config, never in the repo). */
  private localRepos: Record<string, string> = {}
  /** The project's code folder on this machine: every board's fallback. */
  private projectRepo?: string

  constructor(root: string, localRepos: Record<string, string> = {}, projectRepo?: string) {
    this.root = path.resolve(root)
    this.localRepos = localRepos
    this.projectRepo = projectRepo
  }

  setLocalRepos(localRepos: Record<string, string>, projectRepo?: string): void {
    this.localRepos = localRepos
    this.projectRepo = projectRepo
    this.resolveInheritance()
  }

  /** Reads everything again (a board folder copied in or taken out) and watches what is there now. */
  async reload(): Promise<void> {
    await this.init()
    if (this.events) this.rewatch()
    this.events?.onTreeChanged()
  }

  // ---- reading -------------------------------------------------------------------------------

  async init(): Promise<void> {
    this.boards.clear()
    this.texts.clear()
    for (const boardPath of await this.findBoards('')) await this.readBoard(boardPath)
    this.resolveInheritance()
    const theme = await readOrUndefined(this.themeFile())
    if (theme !== undefined) this.texts.set(this.themeFile(), theme)
    this.theme = readTheme(theme) ?? undefined
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

  /**
   * A board's code repo, from the nearest board that names one: this machine's own path for it
   * first (the same repo sits at different paths on different machines), then board.json's
   * (relative to the board repo, or absolute) when that folder exists here. Failing both, the
   * project's code folder on this machine.
   */
  private resolveInheritance(): void {
    for (const board of this.boards.values()) {
      let at: string | undefined = board.path
      board.codeRepo = undefined
      board.codeRepoLocal = undefined
      while (at !== undefined) {
        const local = this.localRepos[at]
        const sharedRaw = this.boards.get(at)?.meta.codeRepo
        const shared = sharedRaw ? path.resolve(this.root, sharedRaw) : undefined
        if (local || (shared && existsSync(shared))) {
          board.codeRepo = local || shared
          board.codeRepoLocal = !!local
          break
        }
        at = parentPath(at)
      }
      if (!board.codeRepo && this.projectRepo) board.codeRepo = this.projectRepo
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
        lists: b.meta.lists,
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

  private themeFile(): string {
    return path.join(this.root, THEME_FILE)
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

  /**
   * Removes a board's folder. One with live cards or child boards goes only with `force`: its child
   * boards go with it (all of it stays in the repo's git history). Archived cards don't hold it
   * back, since archiving is how a board is emptied: they go with the folder.
   */
  async deleteBoard(boardPath: string, force = false): Promise<void> {
    const board = this.board(boardPath)
    const children = [...this.boards.keys()].filter(p => p.startsWith(`${boardPath}/`))
    const live = board.cards.filter(c => !c.archived)
    if (!force && live.length) throw new Error('The board still has cards; archive or move them first.')
    if (!force && children.length) throw new Error('The board still has child boards.')
    await fs.rm(path.join(this.root, boardPath), { recursive: true })
    for (const p of [boardPath, ...children]) this.boards.delete(p)
    this.resolveInheritance()
    this.events?.onTreeChanged()
  }

  /** Card keys a board folder (its children included) uses, for a move between repos. */
  keysUnder(boardPath: string): string[] {
    return [...this.boards.entries()]
      .filter(([p]) => p === boardPath || p.startsWith(`${boardPath}/`))
      .map(([, b]) => b.meta.key)
  }

  /** Writes a card that comes from another repo, as it is (its id kept). */
  async adoptCard(boardPath: string, card: Card): Promise<Card> {
    const adopted = { ...card, updated: new Date().toISOString() }
    await this.writeCard(boardPath, adopted)
    return adopted
  }

  /** Takes a card's file away (it moved to another repo). */
  async dropCard(boardPath: string, id: string): Promise<void> {
    const board = this.board(boardPath)
    const file = this.cardFile(boardPath, id)
    this.texts.delete(file)
    await fs.rm(file, { force: true })
    board.cards = board.cards.filter(c => c.id !== id)
    this.events?.onDelta({ path: boardPath, cards: [], removed: [id] })
    this.events?.onTreeChanged()
  }

  async createCard(
    boardPath: string,
    fields: { title: string; list: string | null; pos?: number; body?: string; links?: string[] },
  ): Promise<Card> {
    const board = this.board(boardPath)
    const own = board.cards.filter(c => c.id.startsWith(`${board.meta.key}-`))
    const next = Math.max(0, ...own.map(c => cardNumber(c.id)).filter(n => Number.isFinite(n))) + 1
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

  /** One patch on several cards (archive a list's cards, re-sort a list). */
  async updateCards(boardPath: string, patches: { id: string; patch: CardPatch }[]): Promise<Card[]> {
    const out: Card[] = []
    for (const { id, patch } of patches) out.push(await this.updateCard(boardPath, id, patch))
    return out
  }

  /**
   * Moves a card to another board (or list). The card keeps its id, so its commits' `Card:`
   * trailers and other cards' links still find it; the file moves to the target's cards folder.
   */
  async moveCard(fromPath: string, id: string, toPath: string, list: string | null, pos?: number): Promise<Card> {
    if (fromPath === toPath) return this.updateCard(fromPath, id, { list, ...(pos === undefined ? {} : { pos }) })
    const from = this.board(fromPath)
    const to = this.board(toPath)
    const current = from.cards.find(c => c.id === id)
    if (!current) throw new Error(`No card ${id} on ${fromPath}`)
    const inList = sortCards(to.cards.filter(c => c.list === list && !c.archived))
    const card: Card = {
      ...current,
      list,
      pos: pos ?? between(inList.at(-1)?.pos, undefined),
      updated: new Date().toISOString(),
    }
    await this.writeCard(toPath, card)
    const oldFile = this.cardFile(fromPath, id)
    this.texts.delete(oldFile)
    await fs.rm(oldFile, { force: true })
    from.cards = from.cards.filter(c => c.id !== id)
    this.events?.onDelta({ path: fromPath, cards: [], removed: [id] })
    this.events?.onTreeChanged()
    return card
  }

  /** Moves a list, with every card in it, to the end of another board's lists. */
  async moveList(fromPath: string, listId: string, toPath: string): Promise<string> {
    if (fromPath === toPath) return listId
    const from = this.board(fromPath)
    const to = this.board(toPath)
    const list = from.meta.lists.find(l => l.id === listId)
    if (!list) throw new Error(`No list ${listId} on ${fromPath}`)
    let id = list.id
    for (let n = 2; to.meta.lists.some(l => l.id === id); n++) id = `${list.id}-${n}`
    await this.updateMeta(toPath, { lists: [...to.meta.lists, { ...list, id }] })
    for (const card of sortCards(from.cards.filter(c => c.list === listId))) {
      await this.moveCard(fromPath, card.id, toPath, id, card.pos)
    }
    await this.updateMeta(fromPath, { lists: from.meta.lists.filter(l => l.id !== listId) })
    return id
  }

  async duplicateCard(boardPath: string, id: string): Promise<Card> {
    const board = this.board(boardPath)
    const source = board.cards.find(c => c.id === id)
    if (!source) throw new Error(`No card ${id} on ${boardPath}`)
    const inList = sortCards(board.cards.filter(c => c.list === source.list && !c.archived))
    const after = inList[inList.findIndex(c => c.id === id) + 1]
    return this.createCard(boardPath, {
      title: `${source.title} (copy)`,
      list: source.list,
      pos: between(source.pos, after?.pos),
      body: source.body,
      links: [...source.links],
    })
  }

  async saveMap(boardPath: string, map: BoardMap): Promise<void> {
    const board = this.board(boardPath)
    const nodes: BoardMap['nodes'] = {}
    for (const id of Object.keys(map.nodes).sort((a, b) => cardNumber(a) - cardNumber(b))) {
      nodes[id] = { x: Math.round(map.nodes[id].x), y: Math.round(map.nodes[id].y) }
    }
    const areas: NonNullable<BoardMap['areas']> = {}
    for (const [id, a] of Object.entries(map.areas ?? {})) {
      areas[id] = { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.w), h: Math.round(a.h) }
    }
    board.map = { ...map, nodes, ...(map.areas ? { areas } : {}) }
    await this.writeText(this.mapFile(boardPath), formatJson(board.map))
  }

  /** Writes the project's theme; an empty one (or null) removes the file: the app's own colours. */
  async saveTheme(theme: ProjectTheme | null): Promise<void> {
    const file = this.themeFile()
    if (isEmptyTheme(theme)) {
      this.texts.delete(file)
      await fs.rm(file, { force: true })
      this.theme = undefined
    } else {
      const text = themeText(theme!, this.texts.get(file))
      await this.writeText(file, text)
      this.theme = readTheme(text) ?? undefined
    }
    this.events?.onTreeChanged()
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
    await renameOver(tmp, abs)
  }

  // ---- watching ------------------------------------------------------------------------------

  /**
   * Watches the board folders, never `.git`: a recursive watch of the repo also watched `.git`,
   * and the folders a rebase makes and removes there ended the watch without a word, after which
   * no change on disk reached the screen.
   */
  watch(events: StoreEvents): void {
    this.events = events
    this.rewatch()
  }

  private rewatch(): void {
    const wanted = new Set<string>([''])
    for (const p of this.boards.keys()) {
      // The board, every folder above it (a board may sit in a plain folder) and its cards.
      const parts = p.split('/')
      for (let i = 1; i <= parts.length; i++) wanted.add(parts.slice(0, i).join('/'))
      wanted.add(`${p}/cards`)
    }
    for (const [rel, watcher] of this.watchers) {
      if (!wanted.has(rel)) {
        watcher.close()
        this.watchers.delete(rel)
      }
    }
    for (const rel of wanted) {
      if (this.watchers.has(rel)) continue
      try {
        const watcher = watch(path.join(this.root, rel), (_event, filename) => {
          if (!filename) return
          const name = filename.toString()
          if (name === '.git' || name.endsWith('.tmp')) return
          this.pending.add(rel ? `${rel}/${name}` : name)
          clearTimeout(this.flushTimer)
          this.flushTimer = setTimeout(() => void this.flush(), 80)
        })
        watcher.on('error', () => {
          // The folder went away (a board deleted, a branch switched): watch again what is left.
          watcher.close()
          this.watchers.delete(rel)
          setTimeout(() => this.rewatch(), 200)
        })
        this.watchers.set(rel, watcher)
      } catch {
        /* not there (yet): a cards folder appears with its first card, and the board's watch sees it */
      }
    }
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
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
      if (rel === THEME_FILE) {
        const text = await readOrUndefined(abs)
        if (this.texts.get(abs) === text) continue
        if (text === undefined) this.texts.delete(abs)
        else this.texts.set(abs, text)
        const theme = readTheme(text)
        // A half-saved hand edit keeps the colours on screen until the next save.
        if (theme === null) continue
        this.theme = theme
        treeChanged = true
      } else if (name === 'board.json') {
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
        const card = tryParseCard(text, id)
        // Saved half-way (front matter that does not parse): the card stays as it was until the next save.
        if (!card) continue
        const isNew = !board.cards.some(c => c.id === card.id)
        board.cards = sortCards([...board.cards.filter(c => c.id !== card.id), card])
        delta(boardPath).cards.push(card)
        if (isNew) treeChanged = true
      } else if (name === 'cards' && this.boards.has(parts.slice(0, -1).join('/'))) {
        // Windows also reports a watched folder's subfolder whenever a file in it changes: once the
        // cards folder has a watch of its own, that watch has the file.
        if (this.watchers.has(rel) && (await exists(abs))) continue
        // A board's cards folder appeared (its first card, written by a session): read it whole,
        // since the cards in it may have landed before its watch did.
        const boardPath = parts.slice(0, -1).join('/')
        const board = await this.readBoard(boardPath)
        if (board) {
          delta(boardPath).cards.push(...board.cards)
          treeChanged = true
        }
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
    if (treeChanged || changed.some(rel => !rel.split('/').at(-1)!.includes('.'))) this.rewatch()
    for (const d of deltas.values()) this.events?.onDelta(d)
    if (treeChanged) this.events?.onTreeChanged()
  }
}

/** A theme.json's text as the project's theme: undefined for none (or no colour), null when unreadable. */
function readTheme(text: string | undefined): ProjectTheme | undefined | null {
  if (text === undefined) return undefined
  const theme = parseTheme(text)
  if (!theme) return null
  return isEmptyTheme(theme) ? undefined : theme
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

/**
 * fs.rename onto an existing file, retried for a few seconds on Windows: there it fails (EPERM,
 * EBUSY) while another process has the old file open, as the auto-commit's git or a virus scanner
 * does for a moment after a write.
 */
async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fs.rename(from, to)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw error
      await new Promise(r => setTimeout(r, 25 * attempt))
    }
  }
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
