import { create } from 'zustand'
import { sortCards } from '@shared/cardfile'
import type { CorkboardApi } from '@shared/api'
import type {
  AppConfig,
  BoardDelta,
  BoardNode,
  Card,
  ClaudeInfo,
  CodeCommit,
  LoadedBoard,
  PtyInfo,
  SyncStatus,
} from '@shared/types'
import type { MenuItem } from './components/ContextMenu'

export const api: CorkboardApi = (window as unknown as { corkboard: CorkboardApi }).corkboard

export type ViewMode = 'board' | 'map' | 'table'
export type Tab = { path: string; view: ViewMode }

type UiPrefs = {
  tabs: Tab[]
  activeTab: string | null
  sidebarWidth: number
  terminalHeight: number
  expanded: string[]
  /** Collapsed list ids, per board path. */
  collapsed: Record<string, string[]>
}

const PREFS_KEY = 'corkboard.ui'

function loadPrefs(): UiPrefs {
  const fallback: UiPrefs = {
    tabs: [],
    activeTab: null,
    sidebarWidth: 260,
    terminalHeight: 300,
    expanded: [],
    collapsed: {},
  }
  try {
    return { ...fallback, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<UiPrefs>) }
  } catch {
    return fallback
  }
}

type Modal =
  | { kind: 'newBoard'; parent: string }
  | { kind: 'settings'; path: string }
  | { kind: 'confirm'; title: string; body: string; confirm: string; onConfirm: () => void }

type State = UiPrefs & {
  config: AppConfig | null | undefined
  tree: BoardNode[]
  boards: Record<string, LoadedBoard>
  commits: Record<string, CodeCommit[]>
  selected: Record<string, string[]>
  openCard: { boardPath: string; id: string } | null
  terminals: PtyInfo[]
  exited: Record<string, number>
  activeTerminal: string | null
  terminalOpen: boolean
  modal: Modal | null
  toast: { text: string; tone: 'info' | 'error' } | null
  lastCommit: { summary: string; at: number } | null
  sync: SyncStatus
  claude: ClaudeInfo | null
  contextMenu: { x: number; y: number; items: MenuItem[] } | null
  /** Set to open the card drawer with its link picker focused. */
  focusLinks: number
}

export const useStore = create<State>(() => ({
  ...loadPrefs(),
  config: undefined,
  tree: [],
  boards: {},
  commits: {},
  selected: {},
  openCard: null,
  terminals: [],
  exited: {},
  activeTerminal: null,
  terminalOpen: false,
  modal: null,
  toast: null,
  lastCommit: null,
  sync: { state: 'idle' },
  claude: null,
  contextMenu: null,
  focusLinks: 0,
}))

const set = useStore.setState
const get = useStore.getState

useStore.subscribe(state => {
  const prefs: UiPrefs = {
    tabs: state.tabs,
    activeTab: state.activeTab,
    sidebarWidth: state.sidebarWidth,
    terminalHeight: state.terminalHeight,
    expanded: state.expanded,
    collapsed: state.collapsed,
  }
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* private storage: the layout simply is not remembered */
  }
})

// ---- terminal output: buffered until its xterm mounts -----------------------------------------

const ptyBuffers = new Map<string, string[]>()
const ptySinks = new Map<string, (data: string) => void>()

export function attachTerminalSink(id: string, sink: (data: string) => void): () => void {
  for (const chunk of ptyBuffers.get(id) ?? []) sink(chunk)
  ptyBuffers.delete(id)
  ptySinks.set(id, sink)
  return () => {
    if (ptySinks.get(id) === sink) ptySinks.delete(id)
  }
}

// ---- actions -----------------------------------------------------------------------------------

export const actions = {
  async boot() {
    api.on.delta(applyDelta)
    api.on.treeChanged(() => void actions.refreshTree())
    api.on.boardCommitted(summary => set({ lastCommit: { summary, at: Date.now() } }))
    api.on.ptyCreated(info => {
      set(s => ({
        terminals: s.terminals.some(t => t.id === info.id) ? s.terminals : [...s.terminals, info],
        activeTerminal: info.id,
        terminalOpen: true,
      }))
    })
    api.on.ptyData((id, data) => {
      const sink = ptySinks.get(id)
      if (sink) sink(data)
      else {
        const buffer = ptyBuffers.get(id) ?? []
        buffer.push(data)
        ptyBuffers.set(id, buffer)
      }
    })
    api.on.ptyExit((id, code) => {
      set(s => ({ exited: { ...s.exited, [id]: code } }))
      // `claude update` finished: show the version it left.
      if (get().terminals.find(t => t.id === id)?.title === 'claude update') void actions.refreshClaude()
    })
    api.on.syncStatus(sync => set({ sync }))
    void api.sync.status().then(sync => set({ sync }))
    void actions.refreshClaude()
    const config = await api.config.get()
    set({ config })
    if (config) await actions.afterRootOpened()
  },

  async pickRoot() {
    const config = await api.config.pickRoot()
    if (!config) return
    set({ config, boards: {}, commits: {}, tabs: [], activeTab: null, openCard: null })
    await actions.afterRootOpened()
  },

  async afterRootOpened() {
    await actions.refreshTree()
    const known = new Set(flatten(get().tree).map(n => n.path))
    const tabs = get().tabs.filter(t => known.has(t.path))
    let activeTab = get().activeTab
    if (!activeTab || !known.has(activeTab)) activeTab = tabs[0]?.path ?? null
    set({ tabs, activeTab })
    for (const tab of tabs) await actions.loadBoard(tab.path)
  },

  async refreshTree() {
    const tree = await api.boards.tree()
    set({ tree })
    // A board renamed or edited on disk: reload the open ones.
    for (const path of Object.keys(get().boards)) {
      if (!flatten(tree).some(n => n.path === path)) {
        set(s => {
          const boards = { ...s.boards }
          delete boards[path]
          return { boards, tabs: s.tabs.filter(t => t.path !== path) }
        })
      }
    }
  },

  async loadBoard(path: string) {
    const board = await api.boards.load(path)
    set(s => ({ boards: { ...s.boards, [path]: board } }))
    void actions.loadCommits(path)
  },

  async loadCommits(path: string) {
    const commits = await api.git.cardCommits(path)
    set(s => ({ commits: { ...s.commits, [path]: commits } }))
  },

  async openBoard(path: string, view?: ViewMode) {
    set(s => ({
      tabs: s.tabs.some(t => t.path === path)
        ? s.tabs.map(t => (t.path === path && view ? { ...t, view } : t))
        : [...s.tabs, { path, view: view ?? 'board' }],
      activeTab: path,
    }))
    if (!get().boards[path]) await actions.loadBoard(path)
    else void actions.loadCommits(path)
  },

  closeTab(path: string) {
    set(s => {
      const index = s.tabs.findIndex(t => t.path === path)
      const tabs = s.tabs.filter(t => t.path !== path)
      const activeTab = s.activeTab === path ? (tabs[Math.max(0, index - 1)]?.path ?? null) : s.activeTab
      const openCard = s.openCard?.boardPath === path ? null : s.openCard
      return { tabs, activeTab, openCard }
    })
  },

  setView(path: string, view: ViewMode) {
    set(s => ({ tabs: s.tabs.map(t => (t.path === path ? { ...t, view } : t)) }))
  },

  toggleExpanded(path: string) {
    set(s => ({
      expanded: s.expanded.includes(path) ? s.expanded.filter(p => p !== path) : [...s.expanded, path],
    }))
  },

  toggleSelected(boardPath: string, id: string) {
    set(s => {
      const current = s.selected[boardPath] ?? []
      const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id]
      return { selected: { ...s.selected, [boardPath]: next } }
    })
  },

  clearSelection(boardPath: string) {
    set(s => ({ selected: { ...s.selected, [boardPath]: [] } }))
  },

  openCard(boardPath: string, id: string) {
    set({ openCard: { boardPath, id } })
  },

  closeCard() {
    set({ openCard: null })
  },

  /** Applies a card change at once, before the file write comes back as a delta. */
  patchLocal(boardPath: string, card: Card) {
    set(s => {
      const board = s.boards[boardPath]
      if (!board) return s
      const cards = sortCards([...board.cards.filter(c => c.id !== card.id), card])
      return { boards: { ...s.boards, [boardPath]: { ...board, cards } } }
    })
  },

  setMapLocal(boardPath: string, map: LoadedBoard['map']) {
    set(s => {
      const board = s.boards[boardPath]
      return board ? { boards: { ...s.boards, [boardPath]: { ...board, map } } } : s
    })
  },

  async updateCard(boardPath: string, id: string, patch: Partial<Card>) {
    const board = get().boards[boardPath]
    const current = board?.cards.find(c => c.id === id)
    if (current) actions.patchLocal(boardPath, { ...current, ...patch })
    try {
      return await api.cards.update(boardPath, id, patch)
    } catch (error) {
      actions.toast((error as Error).message, 'error')
      await actions.loadBoard(boardPath)
      return undefined
    }
  },

  async refreshClaude() {
    set({ claude: await api.claude.info() })
  },

  async updateClaude() {
    await api.claude.update(get().activeTab ?? undefined)
  },

  async syncNow() {
    set(s => ({ sync: { ...s.sync, state: 'syncing' } }))
    const status = await api.sync.now()
    set({ sync: status })
    if (status.state === 'conflict' || status.state === 'offline') actions.toast(status.message ?? status.state, 'error')
  },

  copy(text: string, what = text) {
    api.clipboard.write(text)
    actions.toast(`Copied ${what}`)
  },

  selectMany(boardPath: string, ids: string[]) {
    set(s => ({ selected: { ...s.selected, [boardPath]: ids } }))
  },

  toggleCollapsed(boardPath: string, listId: string) {
    set(s => {
      const current = s.collapsed[boardPath] ?? []
      const next = current.includes(listId) ? current.filter(x => x !== listId) : [...current, listId]
      return { collapsed: { ...s.collapsed, [boardPath]: next } }
    })
  },

  /** Moves a card to a list on this board or another one; follows it to its new board. */
  async moveCard(fromPath: string, id: string, toPath: string, list: string | null, pos?: number) {
    try {
      if (fromPath === toPath) {
        await actions.updateCard(fromPath, id, pos === undefined ? { list } : { list, pos })
        return
      }
      await api.cards.move(fromPath, id, toPath, list, pos)
      if (get().openCard?.id === id) set({ openCard: null })
      if (get().boards[toPath]) await actions.loadBoard(toPath)
      const target = findNode(get().tree, toPath)
      actions.toast(`Moved ${id} to ${target?.title ?? toPath}`)
    } catch (error) {
      actions.toast((error as Error).message, 'error')
    }
  },

  toast(text: string, tone: 'info' | 'error' = 'info') {
    set({ toast: { text, tone } })
    const shown = get().toast
    setTimeout(() => {
      if (get().toast === shown) set({ toast: null })
    }, tone === 'error' ? 7000 : 3500)
  },

  setModal(modal: Modal | null) {
    set({ modal })
  },

  confirm(title: string, body: string, confirm: string): Promise<boolean> {
    return new Promise(resolve => {
      set({
        modal: {
          kind: 'confirm',
          title,
          body,
          confirm,
          onConfirm: () => resolve(true),
        },
      })
      const unsub = useStore.subscribe(state => {
        if (state.modal?.kind !== 'confirm') {
          unsub()
          resolve(false)
        }
      })
    })
  },

  async newTerminal(boardPath?: string) {
    await api.pty.create({ title: 'shell', boardPath })
  },

  closeTerminal(id: string) {
    api.pty.kill(id)
    set(s => {
      const terminals = s.terminals.filter(t => t.id !== id)
      return {
        terminals,
        activeTerminal: s.activeTerminal === id ? (terminals.at(-1)?.id ?? null) : s.activeTerminal,
        terminalOpen: terminals.length ? s.terminalOpen : false,
      }
    })
    ptyBuffers.delete(id)
    ptySinks.delete(id)
  },
}

function applyDelta(delta: BoardDelta): void {
  set(s => {
    const board = s.boards[delta.path]
    if (!board) return s
    const changed = new Set(delta.cards.map(c => c.id))
    const removed = new Set(delta.removed)
    const cards = sortCards([
      ...board.cards.filter(c => !changed.has(c.id) && !removed.has(c.id)),
      ...delta.cards,
    ])
    return {
      boards: {
        ...s.boards,
        [delta.path]: {
          ...board,
          cards,
          meta: delta.meta ?? board.meta,
          map: delta.map ?? board.map,
        },
      },
    }
  })
  if (delta.meta) void actions.loadBoard(delta.path)
}

export function flatten(nodes: BoardNode[]): BoardNode[] {
  return nodes.flatMap(n => [n, ...flatten(n.children)])
}

export function findNode(nodes: BoardNode[], path: string): BoardNode | undefined {
  return flatten(nodes).find(n => n.path === path)
}

/** Stable colour per list position, for strips and map nodes. */
export const LIST_COLORS = ['#5b8def', '#e0a93b', '#4cb782', '#d9645b', '#a77bdb', '#3fb5c4', '#d77fb1', '#8f9bb3']

export function listColor(board: LoadedBoard, listId: string | null): string {
  if (listId === null) return '#c9b458'
  const index = board.meta.lists.findIndex(l => l.id === listId)
  return index < 0 ? '#6b7280' : LIST_COLORS[index % LIST_COLORS.length]
}

export function commitsFor(commits: CodeCommit[] | undefined, id: string): CodeCommit[] {
  return (commits ?? []).filter(c => c.cards.includes(id.toUpperCase()))
}

/** A shared empty list for selectors: a fresh `[]` per call would re-render forever. */
export const NONE: string[] = []

/** An ISO time in the viewer's own zone, e.g. "Oct 3, 2026, 3:50 PM". */
export function localTime(iso: string | undefined, withTime = true): string {
  if (!iso) return '?'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return withTime
    ? date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : date.toLocaleDateString([], { dateStyle: 'medium' })
}
