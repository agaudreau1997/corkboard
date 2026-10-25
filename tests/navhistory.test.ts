import { describe, expect, it } from 'vitest'
import { emptyHistory, step, visit, type NavHistory, type Place } from '@shared/navhistory'

const a: Place = { path: 'p:a', view: 'board' }
const aMap: Place = { path: 'p:a', view: 'map' }
const b: Place = { path: 'p:b', view: 'board' }
const c: Place = { path: 'p:c', view: 'table' }
const open = () => true

function walk(...places: Place[]): NavHistory {
  return places.reduce(visit, emptyHistory())
}

describe('tab history', () => {
  it('keeps each tab and view shown, once', () => {
    const history = walk(a, a, aMap, b, b)
    expect(history.places).toEqual([a, aMap, b])
    expect(history.index).toBe(2)
  })

  it('goes back and forward through them', () => {
    let history = walk(a, aMap, b)
    const back = step(history, -1, b, open)!
    expect(back.place).toEqual(aMap)
    history = visit(back.history, back.place)
    expect(history.index).toBe(1)
    expect(step(history, -1, aMap, open)!.place).toEqual(a)
    expect(step(history, 1, aMap, open)!.place).toEqual(b)
    expect(step(walk(a, b), 1, b, open)).toBeUndefined()
    expect(step(walk(a), -1, a, open)).toBeUndefined()
  })

  it('drops the places ahead when somewhere new is shown after going back', () => {
    const back = step(walk(a, b), -1, b, open)!
    const history = visit(back.history, c)
    expect(history.places).toEqual([a, c])
    expect(step(history, 1, c, open)).toBeUndefined()
  })

  it('passes over closed tabs and the place already in front', () => {
    // a, b, a with b closed: back passes over b, and the first a is what is already in front.
    expect(step(walk(a, b, a), -1, a, p => p !== b.path)).toBeUndefined()
    const back = step(walk(c, a, b, aMap), -1, aMap, p => p !== b.path)!
    expect(back.place).toEqual(a)
    expect(back.history.index).toBe(1)
    const further = step(back.history, -1, a, p => p !== b.path)!
    expect(further.place).toEqual(c)
    expect(step(further.history, 1, c, p => p !== b.path)!.place).toEqual(a)
  })

  it('forgets the oldest places past a hundred', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ path: `p:${i}`, view: 'board' }))
    const history = walk(...many)
    expect(history.places).toHaveLength(100)
    expect(history.places[0].path).toBe('p:20')
    expect(history.index).toBe(99)
  })
})
