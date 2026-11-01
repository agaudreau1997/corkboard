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
      if (next === id || !byId.has(next)) continue
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

/**
 * The cards with every card after the cards it waits on, otherwise in the order given (a list's
 * order, a selection's): the order one session works them in. A loop (refused before a tackle
 * starts) leaves its cards in the order given.
 */
export function orderCards<C extends Ordered>(cards: C[]): C[] {
  const ids = new Set(cards.map(c => c.id))
  const waiting = new Map(cards.map(c => [c.id, new Set(c.after.filter(id => ids.has(id) && id !== c.id))]))
  const out: C[] = []
  const left = [...cards]
  while (left.length) {
    const i = Math.max(0, left.findIndex(c => waiting.get(c.id)!.size === 0))
    const [next] = left.splice(i, 1)
    out.push(next)
    for (const set of waiting.values()) set.delete(next.id)
  }
  return out
}

/**
 * The sessions a tackle of several cards starts. Together, one for all of them, in order. One
 * per card, the cards an order joins (directly or through others among them) share a session in
 * that order, and the rest get one each: work that waits on other work can't start beside it.
 */
export function tackleGroups<C extends Ordered>(cards: C[], split: 'together' | 'each' = 'together'): C[][] {
  if (split === 'together') return [orderCards(cards)]
  const ids = new Set(cards.map(c => c.id))
  const root = new Map(cards.map(c => [c.id, c.id]))
  const find = (id: string): string => {
    while (root.get(id) !== id) id = root.get(id)!
    return id
  }
  for (const card of cards) {
    for (const id of card.after) if (ids.has(id)) root.set(find(id), find(card.id))
  }
  const groups = new Map<string, C[]>()
  for (const card of cards) {
    const key = find(card.id)
    groups.set(key, [...(groups.get(key) ?? []), card])
  }
  return [...groups.values()].map(orderCards)
}

/**
 * The cards waited on that the tackle leaves out and that aren't done yet (not in the done list,
 * not complete, not archived), by the card waiting on them. Cards of another board are no part
 * of a board's order, so they're not counted.
 */
export function unmetPrerequisites(cards: Ordered[], board: Card[], doneList?: string): { id: string; needs: string[] }[] {
  const ids = new Set(cards.map(c => c.id))
  const open = (id: string) => {
    const card = board.find(c => c.id === id)
    return !!card && !card.archived && !card.complete && (!doneList || card.list !== doneList)
  }
  return cards.flatMap(c => {
    const needs = c.after.filter(id => !ids.has(id) && open(id))
    return needs.length ? [{ id: c.id, needs }] : []
  })
}
