// A board's selection of cards (the ones Ctrl- and Shift-clicked, for a tackle or a move of many),
// kept as ids in the renderer's store. These are the rules it follows, kept pure so they can be
// tested: the selection drops a card that leaves the board or is archived, whatever changed it,
// and Shift-click adds the cards between the anchor and the clicked one in the order the view
// shows them, which is why each view works its order out the way it draws it.

import { isDivider, listSort, orderList } from './cardfile'
import type { Card, LoadedBoard } from './types'

/** The board view's column of cards with no list (ideas that only live on the map). */
export const UNLISTED = '__unlisted__'

/** Card ids per column of the board view, keyed by list id (UNLISTED for the ideas). */
export type Columns = Record<string, string[]>

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

/** The board view's columns: each list's cards that pass the filter, as the list sorts them. */
export function boardColumns(board: Pick<LoadedBoard, 'meta' | 'cards'>, matches: (c: Card) => boolean): Columns {
  const cards: Record<string, Card[]> = { [UNLISTED]: [] }
  for (const list of board.meta.lists) cards[list.id] = []
  for (const card of board.cards) {
    if (card.archived || !matches(card)) continue
    const key = card.list === null ? UNLISTED : card.list
    if (cards[key]) cards[key].push(card)
  }
  const cols: Columns = { [UNLISTED]: cards[UNLISTED].map(c => c.id) }
  for (const list of board.meta.lists) cols[list.id] = orderList(cards[list.id], listSort(board.meta, list)).map(c => c.id)
  return cols
}

/**
 * The cards of the board view in reading order: its lists left to right (the ideas first when
 * there are any, archived and collapsed lists left out), each one's cards top to bottom.
 * Dividers are not cards to select.
 */
export function boardOrder(board: Pick<LoadedBoard, 'meta' | 'cards'>, columns: Columns, collapsed: string[]): string[] {
  const dividers = new Set(board.cards.filter(isDivider).map(c => c.id))
  const lists = [UNLISTED, ...board.meta.lists.filter(l => !l.archived).map(l => l.id)]
  return lists.filter(id => !collapsed.includes(id)).flatMap(id => (columns[id] ?? []).filter(c => !dividers.has(c)))
}

/**
 * The selection after a Shift-click on `to`: every card from the anchor to it, in the view's
 * `order`, added to what was selected. Without an anchor in the order, the clicked card alone.
 */
export function selectRange(selected: string[], order: string[], anchor: string | null, to: string): string[] {
  const end = order.indexOf(to)
  const start = anchor === null ? -1 : order.indexOf(anchor)
  const range = end < 0 ? [] : start < 0 ? [to] : order.slice(Math.min(start, end), Math.max(start, end) + 1)
  const have = new Set(selected)
  const added = range.filter(id => !have.has(id))
  return added.length ? [...selected, ...added] : selected
}
