// What the app's MCP server lets a Claude session do to the boards: read them, and change cards
// through the store, as the window does. A session editing a card file by hand has to keep the
// format, name a list that exists and stamp `updated:` from a clock it has to look up; through
// these the change is checked here and stamped by the store, and the auto-commit and the sync
// take it from there like any change made in the window.
//
// Nothing here deletes a card (cards are archived), commits or syncs (the app does), or touches a
// code repo: a work project's sessions get the same tools, and they never reach its shared repo.

import { between, isDivider, sortCards } from '@shared/cardfile'
import type { BoardMeta, Card, CardPatch, LoadedBoard } from '@shared/types'
import { boardKey, splitKey } from './projects'
import type { BoardStore } from './store'

/** One open project, as the tools see it. */
export type ToolProject = { id: string; name: string; store: BoardStore }

/** The open projects, read on every call (one may open or close while the app runs). */
export type ToolProjects = () => Promise<ToolProject[]> | ToolProject[]

/** A request the tools refuse: its message goes back to the session as the tool's error. */
export class ToolError extends Error {}

/** A card as the tools answer it: what a session needs to see, its board's key and list title included. */
export type CardView = {
  id: string
  board: string
  title: string
  list: string | null
  listTitle?: string
  description: string
  labels: string[]
  links: string[]
  due?: string
  complete?: boolean
  archived?: boolean
  jira?: string
  created?: string
  updated?: string
}

type Found = { project: ToolProject; rel: string; board: LoadedBoard; card: Card }

const JIRA_KEY = /^[A-Z][A-Z0-9_]*-\d+$/
const SEARCH_LIMIT = 50

export class BoardTools {
  constructor(private projects: ToolProjects) {}

  /** Every project and board, with what a session needs to name them: keys, lists and flow. */
  async listBoards() {
    return (await this.projects()).map(p => ({
      project: p.id,
      name: p.name,
      work: !!p.store.settings.work,
      boards: p.store
        .allBoards()
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(b => ({
          board: boardKey(p.id, b.path),
          title: b.meta.title,
          cardPrefix: b.meta.key,
          lists: b.meta.lists.map(l => ({ id: l.id, title: l.title, ...(l.archived ? { archived: true } : {}) })),
          ...(b.meta.flow ? { flow: b.meta.flow } : {}),
          cards: b.cards.filter(c => !c.archived && !isDivider(c)).length,
        })),
    }))
  }

  async getCard(id: string, board?: string): Promise<CardView> {
    const found = await this.find(id, board)
    return view(found)
  }

  /** Cards whose id or title has the query in it, on one board or all, optionally in one list. */
  async searchCards(opts: { query?: string; board?: string; list?: string; archived?: boolean }) {
    const query = opts.query?.trim().toLowerCase() ?? ''
    const boards = opts.board ? [await this.board(opts.board)] : await this.allBoards()
    const out: Omit<CardView, 'description'>[] = []
    let total = 0
    for (const b of boards) {
      for (const card of sortCards(b.board.cards)) {
        if (isDivider(card) || !!card.archived !== !!opts.archived) continue
        if (opts.list !== undefined && card.list !== opts.list) continue
        if (query && !card.id.toLowerCase().includes(query) && !card.title.toLowerCase().includes(query)) continue
        total++
        if (out.length >= SEARCH_LIMIT) continue
        const { description: _, ...rest } = view({ ...b, card })
        out.push(rest)
      }
    }
    return { cards: out, total, ...(total > out.length ? { note: `Only the first ${SEARCH_LIMIT}: narrow the search.` } : {}) }
  }

  /** Moves a card to a list of its board, by id or by the board's flow (`doing`, `done`). */
  async moveCard(opts: { id: string; board?: string; list?: string; flow?: 'doing' | 'done' }): Promise<CardView> {
    const found = await this.find(opts.id, opts.board)
    if ((opts.list === undefined) === (opts.flow === undefined)) throw new ToolError('Give either list or flow.')
    const meta = found.board.meta
    let list = opts.list
    if (opts.flow) {
      list = meta.flow?.[opts.flow]
      if (!list) throw new ToolError(`The board ${key(found)} has no ${opts.flow} list in its flow.`)
    }
    checkList(meta, list!, key(found))
    if (found.card.list === list) return view(found)
    const inList = sortCards(found.board.cards.filter(c => c.list === list && !c.archived))
    return this.patch(found, { list: list!, pos: between(inList.at(-1)?.pos, undefined) })
  }

  async updateCard(opts: {
    id: string
    board?: string
    title?: string
    description?: string
    labels?: string[]
    links?: string[]
    due?: string | null
    complete?: boolean
    jira?: string | null
  }): Promise<CardView> {
    const found = await this.find(opts.id, opts.board)
    const patch: CardPatch = {}
    if (opts.title !== undefined) patch.title = cleanTitle(opts.title)
    if (opts.description !== undefined) patch.body = opts.description.replace(/\s+$/, '')
    if (opts.labels !== undefined) patch.labels = cleanLabels(opts.labels)
    if (opts.links !== undefined) patch.links = this.cleanLinks(found, opts.links)
    if (opts.due !== undefined) patch.due = cleanDue(opts.due)
    if (opts.complete !== undefined) patch.complete = opts.complete || undefined
    if (opts.jira !== undefined) patch.jira = cleanJira(opts.jira)
    if (!Object.keys(patch).length) throw new ToolError('Nothing to change: give at least one field.')
    return this.patch(found, patch)
  }

  /** A new card on a board: in the list given, its flow's list, or the board's first list. */
  async createCard(opts: {
    board: string
    title: string
    list?: string
    flow?: 'doing' | 'done'
    description?: string
    labels?: string[]
    links?: string[]
    due?: string
    jira?: string
  }): Promise<CardView> {
    const b = await this.board(opts.board)
    if (opts.list !== undefined && opts.flow !== undefined) throw new ToolError('Give list or flow, not both.')
    const meta = b.board.meta
    let list = opts.list
    if (opts.flow) {
      list = meta.flow?.[opts.flow]
      if (!list) throw new ToolError(`The board ${opts.board} has no ${opts.flow} list in its flow.`)
    }
    list ??= meta.lists.find(l => !l.archived)?.id
    if (!list) throw new ToolError(`The board ${opts.board} has no list to put a card in.`)
    checkList(meta, list, opts.board)
    const title = cleanTitle(opts.title)
    const links = opts.links ? this.cleanLinks({ ...b, card: undefined }, opts.links) : []
    // Checked before anything is written, so a refused card leaves nothing behind.
    const rest: CardPatch = {}
    if (opts.labels?.length) rest.labels = cleanLabels(opts.labels)
    if (opts.due) rest.due = cleanDue(opts.due)
    if (opts.jira) rest.jira = cleanJira(opts.jira)
    const created = await b.project.store.createCard(b.rel, {
      title,
      list,
      body: opts.description?.replace(/\s+$/, '') ?? '',
      links,
    })
    const found = { ...b, card: created }
    return Object.keys(rest).length ? this.patch(found, rest) : view(found)
  }

  /** Archives a card (or brings it back): the board's way of taking a card away. */
  async archiveCard(opts: { id: string; board?: string; archived?: boolean }): Promise<CardView> {
    const found = await this.find(opts.id, opts.board)
    const archived = opts.archived ?? true
    if (!!found.card.archived === archived) return view(found)
    return this.patch(found, { archived: archived || undefined })
  }

  /** Links one card to another (the link is the first card's, as the map draws it), or unlinks them. */
  async linkCards(opts: { id: string; to: string; board?: string; unlink?: boolean }): Promise<CardView> {
    const found = await this.find(opts.id, opts.board)
    const links = found.card.links
    if (opts.unlink) {
      if (!links.includes(opts.to)) return view(found)
      return this.patch(found, { links: links.filter(l => l !== opts.to) })
    }
    const [to] = this.cleanLinks(found, [opts.to])
    if (links.includes(to)) return view(found)
    return this.patch(found, { links: [...links, to] })
  }

  // ---- finding -------------------------------------------------------------------------------

  private async allBoards(): Promise<{ project: ToolProject; rel: string; board: LoadedBoard }[]> {
    return (await this.projects()).flatMap(project => project.store.allBoards().map(board => ({ project, rel: board.path, board })))
  }

  private async board(key: string): Promise<{ project: ToolProject; rel: string; board: LoadedBoard }> {
    let projectId: string
    let rel: string
    try {
      ;({ projectId, rel } = splitKey(key))
    } catch {
      throw new ToolError(`Not a board key: ${key}. list_boards gives them (<project>:<path>).`)
    }
    const project = (await this.projects()).find(p => p.id === projectId)
    if (!project) throw new ToolError(`No project ${projectId} is open.`)
    const board = project.store.allBoards().find(b => b.path === rel)
    if (!board) throw new ToolError(`No board ${key}.`)
    return { project, rel, board }
  }

  /**
   * A card by id. Ids are unique per board key, and a card keeps its id when it moves to another
   * board: the boards whose key the id starts with are looked at first, then every board. The same
   * key in two projects needs the board named.
   */
  private async find(id: string, board?: string): Promise<Found> {
    const wanted = id.trim()
    if (board) {
      const b = await this.board(board)
      const card = b.board.cards.find(c => c.id === wanted)
      if (!card) throw new ToolError(`No card ${wanted} on ${board}.`)
      return { ...b, card }
    }
    const prefix = wanted.slice(0, wanted.lastIndexOf('-'))
    const all = await this.allBoards()
    const byKey = all.filter(b => b.board.meta.key === prefix)
    for (const boards of [byKey, all]) {
      const hits = boards.flatMap(b => {
        const card = b.board.cards.find(c => c.id === wanted)
        return card ? [{ ...b, card }] : []
      })
      if (hits.length === 1) return hits[0]
      if (hits.length > 1) {
        throw new ToolError(`${wanted} is on more than one board (${hits.map(key).join(', ')}): name the board.`)
      }
    }
    throw new ToolError(`No card ${wanted}.`)
  }

  /** Link targets: cards of the same project, never the card itself; unknown ids are refused. */
  private cleanLinks(at: { project: ToolProject; card?: Card }, ids: string[]): string[] {
    const out: string[] = []
    for (const raw of ids) {
      const id = raw.trim()
      if (!id || out.includes(id)) continue
      if (at.card && id === at.card.id) throw new ToolError('A card cannot link to itself.')
      if (!at.project.store.findCard(id)) throw new ToolError(`No card ${id} in the project ${at.project.id} to link to.`)
      out.push(id)
    }
    return out
  }

  private async patch(found: Found, patch: CardPatch): Promise<CardView> {
    const card = await found.project.store.updateCard(found.rel, found.card.id, patch)
    return view({ ...found, board: found.project.store.board(found.rel), card })
  }
}

function key(found: { project: ToolProject; rel: string }): string {
  return boardKey(found.project.id, found.rel)
}

function view(found: Found): CardView {
  const { card, board } = found
  const list = board.meta.lists.find(l => l.id === card.list)
  return {
    id: card.id,
    board: key(found),
    title: card.title,
    list: card.list,
    ...(list ? { listTitle: list.title } : {}),
    description: card.body,
    labels: card.labels,
    links: card.links,
    ...(card.due ? { due: card.due } : {}),
    ...(card.complete ? { complete: true } : {}),
    ...(card.archived ? { archived: true } : {}),
    ...(card.jira ? { jira: card.jira } : {}),
    ...(card.created ? { created: card.created } : {}),
    ...(card.updated ? { updated: card.updated } : {}),
  }
}

function checkList(meta: BoardMeta, list: string, board: string): void {
  if (meta.lists.some(l => l.id === list)) return
  const ids = meta.lists.map(l => l.id).join(', ')
  throw new ToolError(`The board ${board} has no list ${list}${ids ? ` (its lists: ${ids})` : ''}.`)
}

function cleanTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim()
  if (!clean) throw new ToolError('A card needs a title.')
  return clean
}

function cleanLabels(labels: string[]): string[] {
  return [...new Set(labels.map(l => l.trim()).filter(Boolean))]
}

/** A due date as a day (`2026-11-02`) or a moment (ISO); empty or null clears it. */
function cleanDue(due: string | null): string | undefined {
  const clean = due?.trim()
  if (!clean) return undefined
  if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(clean) || Number.isNaN(Date.parse(clean))) {
    throw new ToolError(`Not a date: ${due}. Give it as 2026-11-02 or an ISO time.`)
  }
  return clean
}

/** A Jira key, upper case as the drawer writes it; empty or null clears it. */
function cleanJira(jira: string | null): string | undefined {
  const clean = jira?.trim().toUpperCase()
  if (!clean) return undefined
  if (!JIRA_KEY.test(clean)) throw new ToolError(`Not a Jira key: ${jira}. A key looks like SPDI-42.`)
  return clean
}
