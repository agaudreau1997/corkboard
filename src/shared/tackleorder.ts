// The order between cards: a card's `after` names the cards of its board to be done before it.
// Unlike `links`, which only says two cards are related, these edges have a direction, and a
// tackle of several cards follows them. An edge to a card outside the cards given (another board,
// an archived card, one not selected) is no edge here: the callers decide what it means.

import type { Card } from './types'

type Ordered = Pick<Card, 'id' | 'after'>

/** The ids of a loop of `after` edges among the cards (each waits on the next), or undefined. */
export function findCycle(cards: Ordered[]): string[] | undefined {
  const byId = new Map(cards.map(c => [c.id, c]))
  const state = new Map<string, 'open' | 'done'>()
  const path: string[] = []
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined
    if (state.get(id) === 'open') return path.slice(path.indexOf(id))
    state.set(id, 'open')
    path.push(id)
    for (const next of byId.get(id)?.after ?? []) {
      if (!byId.has(next)) continue
      const loop = visit(next)
      if (loop) return loop
    }
    path.pop()
    state.set(id, 'done')
    return undefined
  }
  for (const card of cards) {
    const loop = visit(card.id)
    if (loop) return loop
  }
  return undefined
}
