import { describe, expect, it } from 'vitest'
import { boardColumns, boardOrder, pruneSelection, selectRange, UNLISTED } from '@shared/selection'
import type { BoardMeta, Card } from '@shared/types'

const card = (id: string, over: Partial<Card> = {}): Card => ({
  id,
  title: id,
  body: '',
  list: 'todo',
  pos: 1,
  labels: [],
  links: [],
  sessions: [],
  extra: {},
  ...over,
})

describe('pruning the selection', () => {
  const before = [card('A-1'), card('A-2'), card('A-3')]

  it('keeps the same array when every selected card is still on the board', () => {
    const selected = ['A-1', 'A-3']
    expect(pruneSelection(selected, before, [card('A-1'), card('A-2', { archived: true }), card('A-3')])).toBe(selected)
  })

  it('drops a card archived by the change', () => {
    expect(pruneSelection(['A-1', 'A-2'], before, [card('A-1'), card('A-2', { archived: true }), card('A-3')])).toEqual(['A-1'])
  })

  it('drops a card deleted or moved to another board', () => {
    expect(pruneSelection(['A-1', 'A-2', 'A-3'], before, [card('A-2')])).toEqual(['A-2'])
  })

  it('keeps an archived card picked by hand while it was already archived', () => {
    const archived = [card('A-1', { archived: true }), card('A-2')]
    const selected = ['A-1']
    expect(pruneSelection(selected, archived, [card('A-1', { archived: true, title: 'renamed' }), card('A-2')])).toBe(selected)
  })

  it('drops archived cards when the board had not been loaded before', () => {
    expect(pruneSelection(['A-1', 'A-2'], undefined, [card('A-1', { archived: true }), card('A-2')])).toEqual(['A-2'])
  })
})

describe('the board view order', () => {
  const meta: BoardMeta = {
    key: 'A',
    title: 'A',
    lists: [
      { id: 'todo', title: 'To do' },
      { id: 'old', title: 'Old', archived: true },
      { id: 'later', title: 'Later' },
      { id: 'done', title: 'Done', sort: 'title' },
    ],
  }
  const cards = [
    card('A-1', { pos: 3 }),
    card('A-2', { pos: 1 }),
    card('A-3', { pos: 2, title: '---' }),
    card('A-4', { pos: 4, archived: true }),
    card('A-5', { list: 'old' }),
    card('A-6', { list: 'later' }),
    card('A-7', { list: 'done', title: 'zebra' }),
    card('A-8', { list: 'done', title: 'apple' }),
    card('A-9', { list: null }),
    card('A-10', { pos: 5, title: 'hidden by the filter' }),
  ]
  const board = { meta, cards }
  const matches = (c: Card) => !c.title.includes('filter')

  it('runs through the lists left to right, each as it sorts, ideas first', () => {
    const columns = boardColumns(board, matches)
    expect(columns[UNLISTED]).toEqual(['A-9'])
    expect(boardOrder(board, columns, [])).toEqual(['A-9', 'A-2', 'A-1', 'A-6', 'A-8', 'A-7'])
  })

  it('leaves out collapsed lists, dividers, archived cards and lists, and filtered cards', () => {
    expect(boardOrder(board, boardColumns(board, matches), ['later', UNLISTED])).toEqual(['A-2', 'A-1', 'A-8', 'A-7'])
  })
})

describe('a Shift-click range', () => {
  const order = ['A', 'B', 'C', 'D', 'E']

  it('adds the cards from the anchor to the clicked one, either way round', () => {
    expect(selectRange([], order, 'B', 'D')).toEqual(['B', 'C', 'D'])
    expect(selectRange(['E'], order, 'D', 'B')).toEqual(['E', 'B', 'C', 'D'])
  })

  it('keeps what was selected and adds nothing twice', () => {
    expect(selectRange(['C', 'A'], order, 'A', 'C')).toEqual(['C', 'A', 'B'])
    const selected = ['B', 'C']
    expect(selectRange(selected, order, 'B', 'C')).toBe(selected)
  })

  it('takes the clicked card alone without an anchor in the order', () => {
    expect(selectRange(['A'], order, null, 'C')).toEqual(['A', 'C'])
    expect(selectRange([], order, 'gone', 'C')).toEqual(['C'])
  })

  it('selects nothing for a card not in the order', () => {
    const selected = ['A']
    expect(selectRange(selected, order, 'A', 'Z')).toBe(selected)
  })
})
