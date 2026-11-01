// Finding cards on a board, and its archive. The match is the desktop's filter (`cardMatcher` in
// `src/shared/search.ts`): the id, title or description holds the text. Results come in the order
// the board shows them, its ideas first and then each list's cards as the list sorts them, and the
// archived cards that match after them, the last changed first, so one can be found and restored.

import { isDivider, orderList } from '@shared/cardfile'
import { cardMatcher } from '@shared/search'
import { boardColumns, UNLISTED } from '@shared/selection'
import type { Card } from '@shared/types'
import type { Board } from './reader'

/** The board's archived cards, the last changed first. */
export function archivedCards(board: Pick<Board, 'cards'>): Card[] {
  return orderList(board.cards.filter(c => c.archived && !isDivider(c)), 'updated')
}

/** The cards matching the text: the shown ones in the board's order, then the archived ones. */
export function findCards(board: Pick<Board, 'meta' | 'cards'>, query: string): Card[] {
  const matches = cardMatcher(query)
  const columns = boardColumns(board, c => !isDivider(c) && matches(c))
  const byId = new Map(board.cards.map(c => [c.id, c]))
  const shown = [UNLISTED, ...board.meta.lists.filter(l => !l.archived).map(l => l.id)]
  const live = shown.flatMap(id => columns[id] ?? []).map(id => byId.get(id)!)
  return [...live, ...archivedCards(board).filter(matches)]
}

/** Where a card is, for a result: its list's title, or Ideas, and whether it's archived. */
export function whereCard(board: Pick<Board, 'meta'>, card: Card): string {
  const list = card.list === null ? 'Ideas' : (board.meta.lists.find(l => l.id === card.list)?.title ?? card.list)
  return card.archived ? `Archived · ${list}` : list
}
