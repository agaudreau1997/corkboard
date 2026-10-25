// Where the window has been, for going back and forward with mouse buttons 4 and 5 as in a
// browser: each place is a tab and the view it showed. A visit after going back drops the places
// ahead, and a step passes over the places whose tab has since been closed rather than forgetting
// them, so a board opened again is somewhere to go back to. It lives only while the app runs.

export type Place = { path: string; view: string }
export type NavHistory = { places: Place[]; index: number }

/** The most places kept: older ones fall off the back. */
const LIMIT = 100

export const emptyHistory = (): NavHistory => ({ places: [], index: -1 })

const same = (a: Place | undefined, b: Place | undefined) => !!a && !!b && a.path === b.path && a.view === b.view

/** The history after arriving at `place`: unchanged if it is where the history already is. */
export function visit(history: NavHistory, place: Place): NavHistory {
  if (same(history.places[history.index], place)) return history
  const places = [...history.places.slice(0, history.index + 1), place].slice(-LIMIT)
  return { places, index: places.length - 1 }
}

/**
 * One step back (-1) or forward (1) from `current`, over the places whose tab is no longer open
 * and those that would show what is already in front. Undefined when there is nowhere to go.
 */
export function step(
  history: NavHistory,
  dir: -1 | 1,
  current: Place | undefined,
  isOpen: (path: string) => boolean,
): { history: NavHistory; place: Place } | undefined {
  for (let i = history.index + dir; i >= 0 && i < history.places.length; i += dir) {
    const place = history.places[i]
    if (isOpen(place.path) && !same(place, current)) return { history: { ...history, index: i }, place }
  }
  return undefined
}
