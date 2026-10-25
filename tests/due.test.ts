import { describe, expect, it } from 'vitest'
import { dueDay, isOverdue, localDay } from '@shared/due'
import { parseCard, serializeCard } from '@shared/cardfile'

describe('due dates', () => {
  const noon = new Date(2026, 10, 2, 12, 0)

  it('a date is past from the next day on', () => {
    expect(isOverdue('2026-11-01', false, noon)).toBe(true)
    expect(isOverdue('2026-11-02', false, noon)).toBe(false)
    expect(isOverdue('2026-11-03', false, noon)).toBe(false)
  })

  it('a time is past once it has gone by', () => {
    expect(isOverdue(new Date(2026, 10, 2, 11, 0).toISOString(), false, noon)).toBe(true)
    expect(isOverdue(new Date(2026, 10, 2, 13, 0).toISOString(), false, noon)).toBe(false)
  })

  it('a done card, no date, or one that does not parse is never late', () => {
    expect(isOverdue('2026-10-01', true, noon)).toBe(false)
    expect(isOverdue(undefined, false, noon)).toBe(false)
    expect(isOverdue('soon', false, noon)).toBe(false)
  })

  it('reads the date part of a date or a time', () => {
    expect(dueDay('2026-11-02')).toBe('2026-11-02')
    expect(dueDay('2026-11-02T09:30:00.000Z')).toBe('2026-11-02')
    expect(localDay(noon)).toBe('2026-11-02')
  })

  it('a date round-trips through the card file as written', () => {
    const text = '---\nid: T-1\ntitle: A\nlist: todo\npos: 1\ndue: 2026-11-02\n---\n'
    const card = parseCard(text)
    expect(card.due).toBe('2026-11-02')
    expect(serializeCard(card)).toBe(text)
  })
})
