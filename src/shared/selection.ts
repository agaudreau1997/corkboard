// A board's selection of cards (the ones Ctrl-clicked, for a tackle or a move of many), kept as
// ids in the renderer's store. These are the rules it follows, kept pure so they can be tested:
// the selection drops a card that leaves the board or is archived, whatever changed it.

import type { Card } from './types'

/**
 * The selection after the board's cards went from `before` to `after`: a card no longer on the
 * board goes, and so does one archived by this change. One already archived stays, as the table
 * picks those by hand with *Show archived*. The same array when nothing goes, so nothing re-renders.
 */
export function pruneSelection(selected: string[], before: Card[] | undefined, after: Card[]): string[] {
  if (!selected.length) return selected
  const now = new Map(after.map(c => [c.id, c]))
  const was = new Map((before ?? []).map(c => [c.id, c]))
  const next = selected.filter(id => {
    const card = now.get(id)
    return !!card && (!card.archived || !!was.get(id)?.archived)
  })
  return next.length === selected.length ? selected : next
}
