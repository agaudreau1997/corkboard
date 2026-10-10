import { describe, expect, it } from 'vitest'
import { isEmptyStep, replayCard, replayMap, same } from '@shared/mapundo'
import type { BoardMap, Card } from '@shared/types'

const card = (over: Partial<Card> = {}): Card =>
  ({ id: 'G-1', title: 'A card', list: 'todo', pos: 1024, links: [], body: '', extra: {}, ...over }) as Card

describe('map undo: the map', () => {
  const before: BoardMap = { nodes: { 'G-1': { x: 0, y: 0 } }, areas: { todo: { x: 0, y: 0, w: 300, h: 200 } } }
  const after: BoardMap = {
    nodes: { 'G-1': { x: 100, y: 50 }, 'G-2': { x: 10, y: 10 } },
    areas: { todo: { x: 0, y: 0, w: 400, h: 200 } },
    hiddenLists: ['done'],
  }

  it('puts back what the step changed, and drops what it pinned', () => {
    const { map, skipped } = replayMap(after, after, before)
    expect(skipped).toBe(0)
    expect(same(map, before)).toBe(true)
    expect(map.nodes['G-2']).toBeUndefined()
  })

  it('redoes it again', () => {
    expect(same(replayMap(before, before, after).map, after)).toBe(true)
  })

  it('leaves alone what was changed since, and keeps what the step did not touch', () => {
    const now: BoardMap = { ...after, nodes: { ...after.nodes, 'G-1': { x: 999, y: 999 }, 'G-9': { x: 5, y: 5 } } }
    const { map, skipped } = replayMap(now, after, before)
    expect(skipped).toBe(1)
    expect(map.nodes['G-1']).toEqual({ x: 999, y: 999 })
    expect(map.nodes['G-9']).toEqual({ x: 5, y: 5 })
    expect(map.nodes['G-2']).toBeUndefined()
    expect(map.areas?.todo.w).toBe(300)
    expect(map.hiddenLists).toBeUndefined()
  })

  it('does not count what is already as the replay would leave it', () => {
    const { skipped } = replayMap(before, after, before)
    expect(skipped).toBe(0)
  })

  it('shows and hides the ideas', () => {
    const shown: BoardMap = { nodes: {} }
    const hidden: BoardMap = { nodes: {}, showUnlisted: false }
    expect(replayMap(hidden, shown, hidden).map.showUnlisted).toBe(false)
    expect(replayMap(hidden, hidden, shown).map.showUnlisted).toBeUndefined()
  })
})

describe('map undo: cards', () => {
  it('writes back the old values', () => {
    expect(replayCard(card({ list: 'done' }), { list: 'done' }, { list: 'todo' })).toEqual({ list: 'todo' })
    expect(replayCard(card({ links: ['G-2'] }), { links: ['G-2'] }, { links: [] })).toEqual({ links: [] })
  })

  it('leaves a card changed since alone', () => {
    expect(replayCard(card({ list: 'review' }), { list: 'done' }, { list: 'todo' })).toBeNull()
    expect(replayCard(card({ links: ['G-2', 'G-3'] }), { links: ['G-2'] }, { links: [] })).toBeNull()
  })

  it('has nothing to write for a card already there', () => {
    expect(replayCard(card(), { list: 'done' }, { list: 'todo' })).toEqual({})
  })

  it('takes a card back to no list', () => {
    expect(replayCard(card(), { list: 'todo' }, { list: null })).toEqual({ list: null })
  })
})

describe('map undo: steps', () => {
  it('knows a step that changes nothing', () => {
    const map: BoardMap = { nodes: { a: { x: 1, y: 2 } } }
    expect(isEmptyStep({ label: 'x', map: { before: map, after: { nodes: { a: { y: 2, x: 1 } } } }, cards: [] })).toBe(true)
    expect(isEmptyStep({ label: 'x', cards: [{ id: 'G-1', before: { list: 'a' }, after: { list: 'b' } }] })).toBe(false)
  })
})
