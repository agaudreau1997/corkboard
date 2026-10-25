import { create } from 'zustand'
import { listColorAt, sortCards } from '@shared/cardfile'
import { emptyHistory, step, visit, type Place } from '@shared/navhistory'
import { pruneSelection, selectRange as withRange } from '@shared/selection'
import { reordered } from '@shared/sideorder'
import type { CorkboardApi } from '@shared/api'
import type {
  AppConfig,
  BoardDelta,
  BoardNode,
  Card,
  ClaudeInfo,
  CodeCommit,
  ListDef,
  ListSort,
  LoadedBoard,
  NewProject,
  ProjectNode,
  ProjectTheme,
  PtyInfo,
  RepoStatus,
  TerminalStatus,
  UpdateStatus,
} from '@shared/types'
import type { MenuItem } from './components/ContextMenu'

export const api: CorkboardApi = (window as unknown as { corkboard: CorkboardApi }).corkboard

export type ViewMode = 'board' | 'map' | 'table'
export type Tab = { path: string; view: ViewMode }

type UiPrefs = {
  tabs: Tab[]
  activeTab: string | null
  sidebarWidth: number
  /** The side panel folded to its rail of project marks. */
  sidebarCollapsed: boolean
  terminalHeight: number
  /** The card drawer's width. */
  drawerWidth: number
  expanded: string[]
  /** Projects folded shut in the side panel. */
  foldedProjects: string[]
  /** Projects whose offer of a CLAUDE.md was turned down. */
  noGuide: string[]
  /** Collapsed list ids, per board path. */
  collapsed: Record<string, string[]>
}

const PREFS_KEY = 'corkboard.ui'

function loadPrefs(): UiPrefs {
  const fallback: UiPrefs = {
    tabs: [],
    activeTab: null,
    sidebarWidth: 260,
    sidebarCollapsed: false,
    terminalHeight: 300,
    drawerWidth: 440,
    expanded: [],
    foldedProjects: [],
    noGuide: [],
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
  | { kind: 'appSettings' }
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
  /** Per board, the card last Ctrl- or Shift-clicked: where a Shift-click's range starts. */
  anchor: Record<string, string>
  openCard: { boardPath: string; id: string } | null
  terminals: PtyInfo[]
  exited: Record<string, number>
  /** Per terminal, once its first title came in; none means a plain shell. */
  terminalStatus: Record<string, TerminalStatus>
  /** Terminals whose Claude finished while their tab was out of sight, until it is looked at. */
  attention: string[]
  activeTerminal: string | null
  terminalOpen: boolean
  modal: Modal | null
  toast: { text: string; tone: 'info' | 'error' } | null
  lastCommit: { projectId: string; summary: string; at: number } | null
  claude: ClaudeInfo | null
  /** Corkboard's own version and its updates. */
  update: UpdateStatus | null
  /** Whether claude:// links reach the Claude desktop app on this machine. */
  desktop: boolean
  contextMenu: { x: number; y: number; items: MenuItem[] } | null
  /** Set to open the card drawer with its link picker focused. */
  focusLinks: number
  /** A project's theme as its settings edit it, shown on the whole window until they close. */
  themePreview: { projectId: string; theme: ProjectTheme | null } | null
  /** The code repo panel's: the active tab's board, where its code repo stands, a push or pull under way. */
  repo: { path: string; status: RepoStatus | null; busy?: 'push' | 'pull' } | null
}

export const useStore = create<State>(() => ({
  ...loadPrefs(),
  config: undefined,
  projects: [],
  tree: [],
  boards: {},
  commits: {},
  selected: {},
  anchor: {},
  openCard: null,
  terminals: [],
  exited: {},
  terminalStatus: {},
  attention: [],
  activeTerminal: null,
  terminalOpen: false,
  modal: null,
  toast: null,
  lastCommit: null,
  claude: null,
  update: null,
  desktop: false,
  contextMenu: null,
  focusLinks: 0,
  themePreview: null,
  repo: null,
}))

const set = useStore.setState
const get = useStore.getState

useStore.subscribe(state => {
  const prefs: UiPrefs = {
    tabs: state.tabs,
    activeTab: state.activeTab,
    sidebarWidth: state.sidebarWidth,
    sidebarCollapsed: state.sidebarCollapsed,
    terminalHeight: state.terminalHeight,
    drawerWidth: state.drawerWidth,
    expanded: state.expanded,
    foldedProjects: state.foldedProjects,
    noGuide: state.noGuide,
    collapsed: state.collapsed,
  }
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* private storage: the layout simply is not remembered */
  }
})

// A terminal on screen has been seen: its attention mark goes.
useStore.subscribe(state => {
  const shown = state.terminalOpen ? state.activeTerminal : null
  if (shown && state.attention.includes(shown)) set({ attention: state.attention.filter(t => t !== shown) })
})

// ---- back and forward through the tabs ----------------------------------------------------------

// Every way of showing a tab or a view (the tab bar, the side panel, a link, a menu) ends in the
// store, so the history is kept here rather than at each of them.
let history = emptyHistory()

function placeOf(state: State): Place | undefined {
  const tab = state.tabs.find(t => t.path === state.activeTab)
  return tab && { path: tab.path, view: tab.view }
}

useStore.subscribe(state => {
  const place = placeOf(state)
  if (place) history = visit(history, place)
})

/** Mouse 4 (back) and 5 (forward), on Linux; on Windows they come as app commands from main. */
function navButtons(e: MouseEvent) {
  if (e.button !== 3 && e.button !== 4) return
  // Nothing else reacts to them: not the page's own history, not a terminal.
  e.preventDefault()
  e.stopPropagation()
  if (e.type === 'mouseup') actions.navigate(e.button === 3 ? -1 : 1)
}

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
    api.on.ptyStatus((id, status) => {
      set(s => {
        const finished = s.terminalStatus[id] === 'working' && status === 'waiting'
        const unseen = !(s.terminalOpen && s.activeTerminal === id)
        const attention = s.attention.filter(t => t !== id)
        if (finished && unseen) attention.push(id)
        return { terminalStatus: { ...s.terminalStatus, [id]: status }, attention }
      })
    })
    api.on.ptyShow(id => {
      if (get().terminals.some(t => t.id === id)) set({ activeTerminal: id, terminalOpen: true })
    })
    api.on.ptyExit((id, code) => {
      set(s => ({ exited: { ...s.exited, [id]: code }, attention: s.attention.filter(t => t !== id) }))
      // `claude update` finished: show the version it left.
      if (get().terminals.find(t => t.id === id)?.title === 'claude update') void actions.refreshClaude()
    })
    api.on.syncStatus((projectId, sync) =>
      set(s => ({ projects: s.projects.map(p => (p.id === projectId ? { ...p, sync } : p)) })),
    )
    api.on.updateStatus(update => set({ update }))
    api.on.navigate(dir => actions.navigate(dir === 'back' ? -1 : 1))
    if (!navigator.userAgent.includes('Windows')) {
      for (const type of ['mousedown', 'mouseup', 'auxclick']) window.addEventListener(type, navButtons as EventListener, true)
    }
    api.on.repoStatus((path, status) => set(s => (s.repo?.path === path ? { repo: { ...s.repo, status } } : s)))
    void actions.refreshClaude()
    void api.updates.status().then(update => set({ update }))
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

  /** Adds a project and opens its main board (made with it when the repo had none). */
  async addProject(opts: NewProject) {
    const id = await api.projects.add(opts)
    set({ config: await api.config.get() })
    await actions.refreshTree()
    set(s => ({ foldedProjects: s.foldedProjects.filter(p => p !== id) }))
    const main = get().projects.find(p => p.id === id)?.mainBoard
    if (main) await actions.openBoard(main)
    return id
  },

  /** Desktop notifications, and the program run when a terminal tab changes state (app settings). */
  async setNotify(notify: { desktop: boolean; command: string }) {
    await api.config.setNotify({ desktop: notify.desktop, command: notify.command.trim() || undefined })
    set({ config: await api.config.get() })
  },

  /**
   * A sibling list of the side panel dragged into a new order: saved in this machine's config and
   * shown at once. The keys of boards since gone drop out with it.
   */
  async reorder(kind: 'projects' | 'boards', siblings: string[]) {
    const config = get().config
    if (!config) return
    const known = new Set(kind === 'projects' ? get().projects.map(p => p.id) : flatten(get().tree).map(n => n.path))
    const list = reordered(config.order?.[kind], siblings, known)
    set({ config: { ...config, order: { ...config.order, [kind]: list } } })
    await api.config.setOrder({ [kind]: list })
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
    set(s => withBoards(s, { ...s.boards, [path]: board }, [path]))
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

  /** Back (-1) or forward (1) to the tab and view shown before, passing over closed tabs. */
  navigate(dir: -1 | 1) {
    const s = get()
    const moved = step(history, dir, placeOf(s), path => s.tabs.some(t => t.path === path))
    if (!moved) return
    history = moved.history
    const { path, view } = moved.place
    set({ activeTab: path, tabs: s.tabs.map(t => (t.path === path ? { ...t, view: view as ViewMode } : t)) })
  },

  toggleExpanded(path: string) {
    set(s => ({
      expanded: s.expanded.includes(path) ? s.expanded.filter(p => p !== path) : [...s.expanded, path],
    }))
  },

  /**
   * Adds a card to the board's selection or takes it out. A selection started while one of the
   * board's cards is open in the drawer starts from that card, so Ctrl+click on a second picks both.
   */
  toggleSelected(boardPath: string, id: string) {
    set(s => {
      let current = s.selected[boardPath] ?? []
      const open = openOn(s, boardPath)
      if (!current.length && open && open !== id) current = [open]
      const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id]
      return { selected: { ...s.selected, [boardPath]: next }, anchor: { ...s.anchor, [boardPath]: id } }
    })
  },

  /**
   * A Shift-click on a card: adds every card from the anchor to it, in the view's `order`, to the
   * board's selection. A selection started this way while a card is open in the drawer runs from
   * that card, as a Ctrl+click's starts with it.
   */
  selectRange(boardPath: string, order: string[], id: string) {
    set(s => {
      const current = s.selected[boardPath] ?? []
      const anchor = (!current.length && openOn(s, boardPath)) || s.anchor[boardPath] || null
      const next = withRange(current, order, anchor, id)
      return { selected: { ...s.selected, [boardPath]: next }, anchor: { ...s.anchor, [boardPath]: id } }
    })
  },

  clearSelection(boardPath: string) {
    set(s => {
      const { [boardPath]: _, ...anchor } = s.anchor
      return { selected: { ...s.selected, [boardPath]: [] }, anchor }
    })
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
      return withBoards(s, { ...s.boards, [boardPath]: { ...board, cards } }, [boardPath])
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

  /**
   * Installs the downloaded update and starts it again. A restart stops the terminals, Claude
   * sessions with them (each can be resumed from its card): with any running, it asks first.
   */
  async restartToUpdate() {
    const s = get()
    const running = s.terminals.filter(t => s.exited[t.id] === undefined)
    if (running.length) {
      const working = running.filter(t => s.terminalStatus[t.id] === 'working').length
      const ok = await actions.confirm(
        'Restart to update?',
        `${running.length === 1 ? 'A terminal is' : `${running.length} terminals are`} still running${working ? `, Claude working in ${working}` : ''}. Restarting stops ${running.length === 1 ? 'it' : 'them'}: a Claude session can be resumed from its card afterwards.`,
        'Restart and update',
      )
      if (!ok) return
    }
    await api.updates.install()
  },

  async syncNow(projectId: string) {
    set(s => ({
      projects: s.projects.map(p => (p.id === projectId ? { ...p, sync: { ...p.sync, state: 'syncing' } } : p)),
    }))
    const status = await api.sync.now(projectId)
    if (status.state === 'conflict' || status.state === 'offline') actions.toast(status.message ?? status.state, 'error')
  },

  /** Follows a board's code repo in the code repo panel (null: none shown). */
  async watchRepo(path: string | null) {
    set({ repo: path ? { path, status: get().repo?.path === path ? (get().repo?.status ?? null) : null } : null })
    const status = await api.git.watchRepo(path).catch(() => null)
    if (path && get().repo?.path === path) set(s => ({ repo: { ...s.repo!, status } }))
  },

  /** Pushes the code repo's branch, once the person agrees to where it goes. */
  async pushRepo(path: string) {
    const status = get().repo?.path === path ? get().repo?.status : null
    if (!status?.branch || !status.remote) return
    const what = status.upstream
      ? `${status.ahead} commit${status.ahead === 1 ? '' : 's'} go${status.ahead === 1 ? 'es' : ''} to ${status.upstream}.`
      : `${status.branch} has no upstream yet: it goes to ${status.remote} as ${status.remote}/${status.branch}, which becomes its upstream.`
    const ok = await actions.confirm(`Push ${status.branch} to ${status.remote}?`, `${what} Nothing is committed.`, 'Push')
    if (!ok) return
    await actions.repoOperation(path, 'push', async () => {
      const after = await api.git.push(path)
      actions.toast(`Pushed ${status.branch} to ${status.remote}`)
      return after
    })
  },

  /** Pulls the code repo's upstream, fast-forward only. */
  async pullRepo(path: string) {
    await actions.repoOperation(path, 'pull', async () => {
      const { status, pulled } = await api.git.pull(path)
      actions.toast(pulled ? `Pulled ${pulled} commit${pulled === 1 ? '' : 's'}` : 'Already up to date')
      void actions.loadCommits(path)
      return status
    })
  },

  /** A push or pull: the panel's buttons wait for it, and what went wrong is a toast. */
  async repoOperation(path: string, busy: 'push' | 'pull', run: () => Promise<RepoStatus | null>) {
    const mark = (next: Partial<NonNullable<State['repo']>>) =>
      set(s => (s.repo?.path === path ? { repo: { ...s.repo, ...next } } : s))
    mark({ busy })
    try {
      const status = await run()
      mark({ status, busy: undefined })
    } catch (error) {
      mark({ busy: undefined })
      // Electron prefixes a handler's error with where it came from: only git's own words are shown.
      actions.toast((error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
    }
  },

  async addGuide(projectId: string) {
    try {
      await api.projects.addGuide(projectId)
      await actions.refreshTree()
      actions.toast('Added CLAUDE.md to the board repo')
    } catch (error) {
      actions.toast((error as Error).message, 'error')
    }
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

  /** The order a list keeps its cards in, from now on. */
  async setListSort(boardPath: string, listId: string, sort: ListSort) {
    const board = get().boards[boardPath]
    if (!board) return
    await actions.setLists(boardPath, board.meta.lists.map(l => (l.id === listId ? { ...l, sort } : l)))
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

  /** Closes a terminal from its tab, asking first when closing would stop something running in it. */
  async requestCloseTerminal(id: string) {
    const s = get()
    const title = s.terminals.find(t => t.id === id)?.title ?? 'terminal'
    let busy: string | null = null
    if (s.exited[id] === undefined) {
      const status = s.terminalStatus[id]
      // Claude at its prompt is not stopped mid-way: its session resumes later.
      if (status === 'working') busy = 'Claude is working in it. Closing stops its turn part-way.'
      else if (status !== 'waiting') {
        const running = await api.pty.running(id)
        if (running) busy = `${running} is still running in it. Closing stops it.`
      }
    }
    if (busy && !(await actions.confirm(`Close “${title}”?`, busy, 'Close terminal'))) return
    actions.closeTerminal(id)
  },

  closeTerminal(id: string) {
    api.pty.kill(id)
    set(s => {
      const terminals = s.terminals.filter(t => t.id !== id)
      const { [id]: _, ...terminalStatus } = s.terminalStatus
      return {
        terminals,
        terminalStatus,
        attention: s.attention.filter(t => t !== id),
        activeTerminal: s.activeTerminal === id ? (terminals.at(-1)?.id ?? null) : s.activeTerminal,
        terminalOpen: terminals.length ? s.terminalOpen : false,
      }
    })
    ptyBuffers.delete(id)
    ptySinks.delete(id)
  },
}

/**
 * Deltas that came in since the last render. A burst (a whole board's cards written at once, by a
 * triage or a sync) arrives as hundreds of deltas; applied one by one, each re-rendered every board
 * and re-sorted its lists, and React gave up on the chain of renders. Batched, a burst is a few.
 */
let pendingDeltas: BoardDelta[] = []
const DELTA_BATCH_MS = 20

function applyDelta(delta: BoardDelta): void {
  if (!pendingDeltas.length) setTimeout(flushDeltas, DELTA_BATCH_MS)
  pendingDeltas.push(delta)
}

function flushDeltas(): void {
  const deltas = pendingDeltas
  pendingDeltas = []
  set(s => {
    const boards = { ...s.boards }
    for (const delta of deltas) {
      const board = boards[delta.path]
      if (!board) continue
      const changed = new Set(delta.cards.map(c => c.id))
      const removed = new Set(delta.removed)
      const cards = [...board.cards.filter(c => !changed.has(c.id) && !removed.has(c.id)), ...delta.cards]
      boards[delta.path] = { ...board, cards, meta: delta.meta ?? board.meta, map: delta.map ?? board.map }
    }
    const paths = new Set(deltas.map(d => d.path))
    for (const path of paths) {
      if (boards[path]) boards[path] = { ...boards[path], cards: sortCards(boards[path].cards) }
    }
    return withBoards(s, boards, paths)
  })
  for (const path of new Set(deltas.filter(d => d.meta).map(d => d.path))) void actions.loadBoard(path)
}

/**
 * The store's boards replaced by `boards`, whose `paths` changed, and those boards' selections
 * pruned of the cards that left them or were archived. Every change of a board's cards (a load, a
 * delta from main, a change applied ahead of its write) lands through here, so a card archived or
 * moved away from anywhere (a menu, the drag tray, a session) leaves the selection with it.
 */
function withBoards(s: State, boards: Record<string, LoadedBoard>, paths: Iterable<string>): Pick<State, 'boards' | 'selected'> {
  let selected = s.selected
  for (const path of paths) {
    const current = s.selected[path]
    if (!current?.length) continue
    const next = pruneSelection(current, s.boards[path]?.cards, boards[path]?.cards ?? [])
    if (next !== current) selected = { ...selected, [path]: next }
  }
  return { boards, selected }
}

/** The card open in the drawer, when it is one of this board's. */
function openOn(s: State, boardPath: string): string | null {
  const open = s.openCard?.boardPath === boardPath ? s.openCard.id : null
  return open && s.boards[boardPath]?.cards.some(c => c.id === open) ? open : null
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

/** A card's commits: those whose trailer names its id, and those whose message names its Jira key. */
export function commitsFor(commits: CodeCommit[] | undefined, card: Pick<Card, 'id' | 'jira'>): CodeCommit[] {
  const id = card.id.toUpperCase()
  const key = card.jira?.trim().toUpperCase()
  return (commits ?? []).filter(c => c.cards.includes(id) || (!!key && c.keys.includes(key)))
}

/** Whether a board's project is in work mode (card ids stay out of its code repo; Jira keys are named). */
export function isWork(boardPath: string): boolean {
  return !!useStore.getState().projects.find(p => p.id === projectIdOf(boardPath))?.work
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
