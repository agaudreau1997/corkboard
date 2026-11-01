// The board tabs: which board a tab shows when one is opened, and how the tabs fold into one per
// project. With one tab per project (a Corkboard setting, on unless turned off), a project's tab
// shows whichever of its boards was opened last, and a board shown before in it is still somewhere
// to go back to. A tab is named by the board it shows, so opening another board of the project
// renames the tab rather than adding one. Each board keeps its own view (board, map, table) in
// `views`, so it comes back as it was left.

export type BoardTab = { path: string; view: string }

/** The project a board key (`<project id>:<path>`) belongs to. */
export const projectOfKey = (key: string): string => key.slice(0, key.indexOf(':'))

/**
 * The tabs once `path` is shown, in `view` when given, else in the view it was last shown in:
 * its own tab if it has one, else its project's (with one tab per project), else a new one at the
 * end.
 */
export function showBoard<T extends BoardTab>(
  tabs: T[],
  path: string,
  opts: { view?: T['view']; views: Record<string, T['view']>; perProject: boolean; fallback: T['view'] },
): T[] {
  const view = opts.view ?? opts.views[path] ?? opts.fallback
  if (tabs.some(t => t.path === path)) return tabs.map(t => (t.path === path && opts.view ? { ...t, view } : t))
  const project = projectOfKey(path)
  const index = opts.perProject ? tabs.findIndex(t => projectOfKey(t.path) === project) : -1
  if (index < 0) return [...tabs, { path, view } as T]
  return tabs.map((t, i) => (i === index ? { ...t, path, view } : t))
}

/** Whether `path` can be shown without a tab of its own: its project's tab would take it. */
export function hasPlace(tabs: BoardTab[], path: string, perProject: boolean): boolean {
  return tabs.some(t => t.path === path) || (perProject && tabs.some(t => projectOfKey(t.path) === projectOfKey(path)))
}

/**
 * The tabs folded to one per project, each where the project's first tab was and on its most
 * recently active board: the active tab if it is the project's, else the first of `recent` (board
 * keys, the latest first), else the rightmost, the one opened last.
 */
export function foldTabs<T extends BoardTab>(tabs: T[], active: string | null, recent: string[]): T[] {
  const rank = (path: string) => (path === active ? -1 : recent.includes(path) ? recent.indexOf(path) : Infinity)
  const kept = new Map<string, T>()
  for (const tab of tabs) {
    const project = projectOfKey(tab.path)
    const before = kept.get(project)
    if (!before || rank(tab.path) <= rank(before.path)) kept.set(project, tab)
  }
  const seen = new Set<string>()
  const folded: T[] = []
  for (const tab of tabs) {
    const project = projectOfKey(tab.path)
    if (seen.has(project)) continue
    seen.add(project)
    folded.push(kept.get(project)!)
  }
  return folded
}
