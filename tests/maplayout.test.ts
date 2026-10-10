import { describe, expect, it } from 'vitest'
import {
  AREA_HEAD,
  AREA_PAD,
  areaAt,
  estimateHeight,
  fitArea,
  growArea,
  layoutArea,
  NODE_W,
  resolveLayout,
} from '@shared/maplayout'

const cards = (n: number, list: string | null = 'todo') =>
  Array.from({ length: n }, (_, i) => ({ id: `G-${i + 1}`, title: `Card number ${i + 1}`, list }))

const inside = (p: { x: number; y: number }, a: { x: number; y: number; w: number; h: number }, h = 50) =>
  p.x >= a.x && p.y >= a.y && p.x + NODE_W <= a.x + a.w && p.y + h <= a.y + a.h

describe('backdrop layout', () => {
  it('lays cards out in columns inside the backdrop, under its header', () => {
    const area = { x: 100, y: 50, w: 800, h: 400 }
    const list = cards(12)
    const { area: out, nodes } = layoutArea(area, list)
    expect(out.x).toBe(100)
    expect(out.y).toBe(50)
    for (const card of list) {
      expect(inside(nodes[card.id], out, estimateHeight(card))).toBe(true)
      expect(nodes[card.id].y).toBeGreaterThanOrEqual(area.y + AREA_HEAD)
    }
    // Several columns, the first starting at the left padding.
    const xs = [...new Set(list.map(c => nodes[c.id].x))]
    expect(xs.length).toBeGreaterThan(1)
    expect(Math.min(...xs)).toBe(area.x + AREA_PAD)
  })

  it('grows a backdrop too small for its cards, and never shrinks one', () => {
    const tight = layoutArea({ x: 0, y: 0, w: 262, h: 140 }, cards(20))
    expect(tight.area.h).toBeGreaterThan(140)
    for (const [id, p] of Object.entries(tight.nodes)) expect(inside(p, tight.area, estimateHeight({ title: `Card number ${id.slice(2)}` }))).toBe(true)
    const roomy = layoutArea({ x: 0, y: 0, w: 2000, h: 2000 }, cards(2))
    expect(roomy.area).toEqual({ x: 0, y: 0, w: 2000, h: 2000 })
  })

  it('finds the backdrop under a point, the smallest of overlapping ones', () => {
    const areas = { big: { x: 0, y: 0, w: 1000, h: 1000 }, small: { x: 100, y: 100, w: 300, h: 300 } }
    expect(areaAt(areas, { x: 150, y: 150 })).toBe('small')
    expect(areaAt(areas, { x: 800, y: 800 })).toBe('big')
    expect(areaAt(areas, { x: 2000, y: 0 })).toBeUndefined()
    expect(areaAt(areas, { x: 150, y: 150 }, new Set(['big']))).toBe('big')
  })

  it('fits a backdrop around its cards', () => {
    const a = fitArea({ x: 0, y: 0, w: 10, h: 10 }, [{ x: 100, y: 200 }, { x: 400, y: 300 }], [50, 70])
    expect(a.x).toBe(100 - AREA_PAD)
    expect(a.y).toBe(200 - AREA_HEAD)
    expect(a.x + a.w).toBe(400 + NODE_W + AREA_PAD)
    expect(a.y + a.h).toBe(300 + 70 + AREA_PAD)
  })

  it('gives every list a backdrop, new ones to the right, keeping saved places', () => {
    const lists = [{ id: 'todo' }, { id: 'doing' }, { id: 'done' }]
    const all = [...cards(3, 'todo'), { id: 'G-9', title: 'Doing thing', list: 'doing' }, { id: 'I-1', title: 'An idea', list: null }]
    const saved = { nodes: { 'G-9': { x: 5000, y: 5000 } }, areas: { todo: { x: 0, y: 0, w: 300, h: 400 } } }
    const { areas, nodes } = resolveLayout(saved, lists, all)
    expect(areas.todo).toEqual(saved.areas.todo)
    expect(areas.doing.x).toBeGreaterThan(300)
    expect(areas.done.x).toBeGreaterThan(areas.doing.x + areas.doing.w - 1)
    expect(nodes['G-9']).toEqual({ x: 5000, y: 5000 })
    expect(inside(nodes['G-1'], areas.todo)).toBe(true)
    expect(nodes['I-1'].x).toBeLessThan(0)
  })

  it('grows a backdrop to hold cards placed outside it, and never shrinks it', () => {
    const area = { x: 0, y: 0, w: 400, h: 300 }
    expect(growArea(area, [], [])).toBe(area)
    expect(growArea(area, [{ x: AREA_PAD, y: AREA_HEAD }], [50])).toBe(area)
    const grown = growArea(area, [{ x: 600, y: 500 }, { x: -100, y: -80 }], [50, 70])
    expect(grown.x).toBe(-100 - AREA_PAD)
    expect(grown.y).toBe(-80 - AREA_HEAD)
    expect(grown.x + grown.w).toBe(600 + NODE_W + AREA_PAD)
    expect(grown.y + grown.h).toBe(500 + 50 + AREA_PAD)
  })

  it('grows a full saved backdrop to take a card that joins its list', () => {
    const lists = [{ id: 'todo' }]
    const area = { x: 0, y: 0, w: 262, h: 300 }
    const { areas, nodes } = resolveLayout({ nodes: {}, areas: { todo: area } }, lists, cards(12))
    expect(areas.todo.x).toBe(0)
    expect(areas.todo.y).toBe(0)
    expect(areas.todo.h).toBeGreaterThan(300)
    for (const card of cards(12)) expect(inside(nodes[card.id], areas.todo, estimateHeight(card))).toBe(true)
  })

  it('grows a backdrop to reach its card dragged out of it, over a neighbour', () => {
    const lists = [{ id: 'todo' }, { id: 'doing' }]
    const map = {
      nodes: { 'G-1': { x: 900, y: 1200 } },
      areas: { todo: { x: 0, y: 0, w: 300, h: 400 }, doing: { x: 400, y: 0, w: 300, h: 400 } },
    }
    const { areas, nodes } = resolveLayout(map, lists, cards(2))
    expect(nodes['G-1']).toEqual({ x: 900, y: 1200 })
    expect(inside(nodes['G-1'], areas.todo, estimateHeight(cards(1)[0]))).toBe(true)
    expect(inside(nodes['G-2'], areas.todo)).toBe(true)
    // The neighbour stays where it was, under the grown backdrop.
    expect(areas.doing).toEqual(map.areas.doing)
    expect(areaAt(areas, { x: 500, y: 100 })).toBe('doing')
  })

  it('places a new backdrop to the right of the grown ones', () => {
    const lists = [{ id: 'todo' }, { id: 'doing' }]
    const map = { nodes: { 'G-1': { x: 1000, y: 50 } }, areas: { todo: { x: 0, y: 0, w: 300, h: 400 } } }
    const { areas } = resolveLayout(map, lists, cards(1))
    expect(areas.doing.x).toBeGreaterThan(areas.todo.x + areas.todo.w)
  })
})
