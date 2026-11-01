import { describe, expect, it } from 'vitest'
import { findCycle, orderCards, tackleGroups, unmetPrerequisites } from '@shared/tackleorder'
import type { Card } from '@shared/types'

const card = (id: string, after: string[] = [], over: Partial<Card> = {}): Card => ({
  id,
  title: id,
  body: '',
  list: 'todo',
  pos: 1,
  labels: [],
  links: [],
  after,
  sessions: [],
  extra: {},
  ...over,
})
const ids = (cards: Card[]) => cards.map(c => c.id)

describe('the order between cards', () => {
  it('finds a loop, and none in an order that branches and joins again', () => {
    expect(findCycle([card('A-1', ['A-3']), card('A-2', ['A-1']), card('A-3', ['A-2'])])).toEqual(['A-1', 'A-3', 'A-2'])
    expect(findCycle([card('A-1'), card('A-2', ['A-1']), card('A-3', ['A-1']), card('A-4', ['A-2', 'A-3'])])).toBeUndefined()
    // A card waiting on itself (a hand edit) or on a card not given is no loop.
    expect(findCycle([card('A-1', ['A-1', 'A-9'])])).toBeUndefined()
  })

  it('puts every card after the ones it waits on, otherwise keeping the order given', () => {
    const cards = [card('A-1', ['A-3']), card('A-2'), card('A-3', ['A-4']), card('A-4')]
    expect(ids(orderCards(cards))).toEqual(['A-2', 'A-4', 'A-3', 'A-1'])
    expect(ids(orderCards([card('A-1'), card('A-2')]))).toEqual(['A-1', 'A-2'])
  })

  it('together: one session in order; one per card: what an order joins shares a session', () => {
    const cards = [card('A-1'), card('A-2', ['A-4']), card('A-3'), card('A-4'), card('A-5', ['A-1']), card('A-6', ['A-9'])]
    expect(tackleGroups(cards).map(ids)).toEqual([['A-1', 'A-3', 'A-4', 'A-2', 'A-5', 'A-6']])
    expect(tackleGroups(cards, 'each').map(ids)).toEqual([['A-1', 'A-5'], ['A-4', 'A-2'], ['A-3'], ['A-6']])
    // Two runs joined through a card waiting on both are one session.
    const joined = [card('A-1'), card('A-2'), card('A-3', ['A-1', 'A-2'])]
    expect(tackleGroups(joined, 'each').map(ids)).toEqual([['A-1', 'A-2', 'A-3']])
  })

  it('names the cards waited on that the tackle leaves out and are not done', () => {
    const board = [
      card('A-1'),
      card('A-2', [], { list: 'done' }),
      card('A-3', [], { complete: true }),
      card('A-4', [], { archived: true }),
      card('A-5', ['A-1', 'A-2', 'A-3', 'A-4', 'A-6', 'B-1']),
      card('A-6'),
    ]
    const tackled = [board[4], board[5]]
    expect(unmetPrerequisites(tackled, board, 'done')).toEqual([{ id: 'A-5', needs: ['A-1'] }])
    // With no done list, a card in a list called done is still open.
    expect(unmetPrerequisites(tackled, board)).toEqual([{ id: 'A-5', needs: ['A-1', 'A-2'] }])
  })
})
