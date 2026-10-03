import { create } from 'zustand'
import { listColorAt, sortCards } from '@shared/cardfile'
import type { CorkboardApi } from '@shared/api'
import type {
  AppConfig,
  BoardDelta,
  BoardNode,
  Card,
  ClaudeInfo,
  CodeCommit,
  ListDef,
  LoadedBoard,
  ProjectNode,
  PtyInfo,
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
  /** Projects folded shut in the side panel. */
  foldedProjects: string[]
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
    foldedProjects: [],
    collapsed: {},
  }
  try {
    return { ...fallback, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<UiPrefs>) }
  } catch {
    return fallback
  }
}

type Modal =
  /** `parent` is a board key, or `<project id>:` for a project's top level. */
  | { kind: 'newBoard'; parent: string }
  | { kind: 'settings'; path: string }
  | { kind: 'addProject' }
  | { kind: 'projectSettings'; id: string }
  | { kind: 'deleteBoard'; path: string }
  | { kind: 'confirm'; title: string; body: string; confirm: string; onConfirm: () => void }

type State = UiPrefs & {
  config: AppConfig | undefined
  /** One per board repo, with its boards. */
  projects: ProjectNode[]
  /** Every project's top-level boards, for lookups by board key. */
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
  lastCommit: { projectId: string; summary: string; at: number } | null
  claude: ClaudeInfo | null
  /** Whether claude:// links reach the Claude desktop app on this machine. */
  desktop: boolean
  contextMenu: { x: number; y: number; items: MenuItem[] } | null
  /** Set to open the card drawer with its link picker focused. */
  focusLinks: number
}

export const useStore = create<State>(() => ({
  ...loadPrefs(),
  config: undefined,
  projects: [],
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
  claude: null,
  desktop: false,
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
    foldedProjects: state.foldedProjects,
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
    api.on.boardCommitted((projectId, summary) => set({ lastCommit: { projectId, summary, at: Date.now() } }))
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
    api.on.syncStatus((projectId, sync) =>
      set(s => ({ projects: s.projects.map(p => (p.id === projectId ? { ...p, sync } : p)) })),
    )
    void actions.refreshClaude()
    void api.claude.desktopAvailable().then(desktop => set({ desktop }))
    const config = await api.config.get()
    set({ config })
    await actions.afterProjectsLoaded()
  },

  async afterProjectsLoaded() {
    await actions.refreshTree()
    // Tabs saved before projects named boards by their path alone: they were the first project's.
    const first = get().projects[0]?.id
    const migrate = (p: string) => (p.includes(':') || !first ? p : `${first}:${p}`)
    set(s => ({
      tabs: s.tabs.map(t => ({ ...t, path: migrate(t.path) })),
      activeTab: s.activeTab ? migrate(s.activeTab) : null,
      expanded: s.expanded.map(migrate),
      collapsed: Object.fromEntries(Object.entries(s.collapsed).map(([k, v]) => [migrate(k), v])),
    }))
    const known = new Set(flatten(get().tree).map(n => n.path))
    const tabs = get().tabs.filter(t => known.has(t.path))
    let activeTab = get().activeTab
    if (!activeTab || !known.has(activeTab)) activeTab = tabs[0]?.path ?? null
    set({ tabs, activeTab })
    for (const tab of tabs) await actions.loadBoard(tab.path)
  },

  async addProject(opts: { boardRoot: string; name?: string; codeRepo?: string }) {
    const id = await api.projects.add(opts)
    set({ config: await api.config.get() })
    await actions.refreshTree()
    set(s => ({ foldedProjects: s.foldedProjects.filter(p => p !== id) }))
    return id
  },

  async removeProject(id: string) {
    await api.projects.remove(id)
    set(s => ({
      tabs: s.tabs.filter(t => !t.path.startsWith(`${id}:`)),
      activeTab: s.activeTab?.startsWith(`${id}:`) ? null : s.activeTab,
      openCard: s.openCard?.boardPath.startsWith(`${id}:`) ? null : s.openCard,
    }))
    set({ config: await api.config.get() })
    await actions.refreshTree()
  },

  async refreshTree() {
    const projects = await api.projects.list()
    const tree = projects.flatMap(p => p.boards)
    set({ projects, tree })
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

  async syncNow(projectId: string) {
    set(s => ({
      projects: s.projects.map(p => (p.id === projectId ? { ...p, sync: { ...p.sync, state: 'syncing' } } : p)),
    }))
    const status = await api.sync.now(projectId)
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

  /** New list order (or titles) for a board: on screen at once, then written. */
  async setLists(boardPath: string, lists: ListDef[]) {
    set(s => {
      const board = s.boards[boardPath]
      return board ? { boards: { ...s.boards, [boardPath]: { ...board, meta: { ...board.meta, lists } } } } : s
    })
    try {
      await api.boards.updateMeta(boardPath, { lists })
    } catch (error) {
      actions.toast((error as Error).message, 'error')
      await actions.loadBoard(boardPath)
    }
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

/** A list's colour (its own once lists have been moved, else its place's); ideas are gold. */
export function listColor(board: LoadedBoard, listId: string | null): string {
  if (listId === null) return '#c9b458'
  const index = board.meta.lists.findIndex(l => l.id === listId)
  return index < 0 ? '#6b7280' : listColorAt(board.meta.lists, index)
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

/** The project a board key belongs to. */
export function projectIdOf(key: string): string {
  return key.slice(0, key.indexOf(':'))
}
