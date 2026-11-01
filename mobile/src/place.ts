// Where you are in the companion: the open repo and board, its list, and what lies over it (the
// side panel from the left, a card's drawer or the new-card form from the right, a board's
// settings). It is remembered so the app reopens on the board you left; what lay over the board is
// not, so the app never reopens on a drawer or the panel, except on a first run, which has no board
// to show and opens the panel by itself. Android's back button closes the top layer first.

export type Place = {
  repo?: string
  /** None while the repo's main board isn't known yet (a repo just picked, never read). */
  board?: string
  list?: string
  /** The card open in the drawer. */
  card?: string
  /** The new-card form is open in the drawer. */
  adding?: boolean
  settings?: boolean
  /** The side panel is open. */
  panel?: boolean
}

const PLACE = 'corkboard:place'

/** The place last saved, as it was saved. */
export function lastPlace(storage: Pick<Storage, 'getItem'> = localStorage): Place {
  try {
    return (JSON.parse(storage.getItem(PLACE) ?? '{}') as Place) ?? {}
  } catch {
    return {}
  }
}

/** What of a place is remembered: the panel never is (the drawers are dropped at start instead). */
export function savePlace(place: Place, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(PLACE, JSON.stringify({ ...place, panel: undefined }))
}

/**
 * Where the app opens: on the board you left, with nothing over it; with no repo yet (a first run),
 * on the side panel, the way to one.
 */
export function startPlace(saved: Place): Place {
  const rest: Place = { ...saved, card: undefined, adding: undefined, panel: undefined }
  return rest.repo ? rest : { ...rest, panel: true }
}

/** Where Android's back button goes: the drawer closes, then the panel, then settings; none: out of the app. */
export function back(place: Place): Place | undefined {
  if (place.adding) return { ...place, adding: undefined }
  if (place.card) return { ...place, card: undefined }
  if (place.panel) return { ...place, panel: undefined }
  if (place.settings) return { ...place, settings: undefined }
  return undefined
}
