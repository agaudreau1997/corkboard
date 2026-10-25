import { describe, expect, it } from 'vitest'
import { pruneSelection } from '@shared/selection'
import type { Card } from '@shared/types'

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
