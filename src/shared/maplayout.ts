// The map view's geometry: every list has a backdrop (an "area") its cards sit on, and cards are
// laid out inside it in columns, top to bottom, the way the board shows them.

import type { BoardMap, Card, MapArea, MapNodePos } from './types'

export const NODE_W = 230
export const COL_W = 250
export const GAP = 14
export const AREA_PAD = 16
export const AREA_HEAD = 40
export const AREA_GAP = 60
export const AREA_MIN_W = NODE_W + AREA_PAD * 2
export const AREA_MIN_H = 140
/** A new backdrop grows its columns to about this height before starting another one. */
export const AREA_DEFAULT_H = 720

/** A map node is 230 px wide, about 32 characters a line, at most four lines of title. */
export function estimateHeight(card: Pick<Card, 'title'>): number {
  const lines = Math.min(4, Math.max(1, Math.ceil(card.title.length / 32)))
  return 36 + lines * 18
}

/**
 * Lays cards out inside a backdrop: columns filled top to bottom. The columns are as tall as the
 * backdrop allows, or taller when its width cannot hold enough of them; the backdrop then grows
 * to what the cards take (never shrinks below its own size).
 */
export function layoutArea(area: MapArea, cards: Pick<Card, 'id' | 'title'>[]): { area: MapArea; nodes: Record<string, MapNodePos> } {
  const heights = cards.map(estimateHeight)
  const total = heights.reduce((sum, h) => sum + h + GAP, 0)
  const fitCols = Math.max(1, Math.floor((area.w - AREA_PAD * 2 + (COL_W - NODE_W)) / COL_W))
  const roomH = Math.max(area.h - AREA_HEAD - AREA_PAD, Math.max(0, ...heights) + GAP)
  const colH = Math.max(roomH, Math.ceil(total / fitCols))
  const nodes: Record<string, MapNodePos> = {}
  let col = 0
  let y = 0
  let tallest = 0
  cards.forEach((card, i) => {
    const h = heights[i]
    if (y > 0 && y + h > colH) {
      col++
      y = 0
    }
    nodes[card.id] = { x: area.x + AREA_PAD + col * COL_W, y: area.y + AREA_HEAD + y }
    y += h + GAP
    tallest = Math.max(tallest, y)
  })
  const usedW = AREA_PAD * 2 + (cards.length ? (col + 1) * COL_W - (COL_W - NODE_W) : NODE_W)
  const usedH = AREA_HEAD + AREA_PAD + tallest
  return {
    area: { ...area, w: Math.max(area.w, usedW, AREA_MIN_W), h: Math.max(area.h, usedH, AREA_MIN_H) },
    nodes,
  }
}

/** The smallest backdrop around a list's cards (with room for its header). */
export function fitArea(area: MapArea, positions: MapNodePos[], heights: number[]): MapArea {
  if (!positions.length) return { ...area, w: AREA_MIN_W, h: AREA_MIN_H }
  const left = Math.min(...positions.map(p => p.x)) - AREA_PAD
  const top = Math.min(...positions.map(p => p.y)) - AREA_HEAD
  const right = Math.max(...positions.map(p => p.x + NODE_W)) + AREA_PAD
  const bottom = Math.max(...positions.map((p, i) => p.y + heights[i])) + AREA_PAD
  return { x: left, y: top, w: Math.max(AREA_MIN_W, right - left), h: Math.max(AREA_MIN_H, bottom - top) }
}

/** The backdrop under a point, the smallest when several overlap. */
export function areaAt(areas: Record<string, MapArea>, point: MapNodePos, among?: Set<string>): string | undefined {
  let best: string | undefined
  let bestSize = Infinity
  for (const [listId, a] of Object.entries(areas)) {
    if (among && !among.has(listId)) continue
    if (point.x < a.x || point.x > a.x + a.w || point.y < a.y || point.y > a.y + a.h) continue
    const size = a.w * a.h
    if (size < bestSize) {
      best = listId
      bestSize = size
    }
  }
  return best
}

/**
 * The map as the view draws it: every shown list gets a backdrop (a saved one, or a new one laid
 * out to the right of the rest), and every card a position (its saved one, or its place in its
 * backdrop's layout). Ideas (no list) get no backdrop: they stack to the left.
 */
export function resolveLayout(
  map: BoardMap,
  lists: { id: string }[],
  cards: Pick<Card, 'id' | 'title' | 'list'>[],
): { areas: Record<string, MapArea>; nodes: Record<string, MapNodePos> } {
  const areas: Record<string, MapArea> = {}
  const nodes: Record<string, MapNodePos> = {}
  const saved = map.areas ?? {}
  const savedAreas = Object.entries(saved).filter(([id]) => lists.some(l => l.id === id))
  let x = savedAreas.length ? Math.max(...savedAreas.map(([, a]) => a.x + a.w)) + AREA_GAP : 0
  const top = savedAreas.length ? Math.min(...savedAreas.map(([, a]) => a.y)) : 0

  for (const list of lists) {
    const inList = cards.filter(c => c.list === list.id)
    let area = saved[list.id]
    if (!area) {
      // A backdrop of its own size for a list that has none yet, after the others.
      const sized = layoutArea({ x, y: top, w: AREA_MIN_W, h: AREA_DEFAULT_H }, inList)
      area = { ...sized.area, h: inList.length ? sized.area.h : AREA_MIN_H }
      x = area.x + area.w + AREA_GAP
    }
    areas[list.id] = area
    const laid = layoutArea(area, inList).nodes
    for (const card of inList) nodes[card.id] = map.nodes[card.id] ?? laid[card.id]
  }

  const ideas = cards.filter(c => c.list === null)
  const minX = Math.min(0, ...Object.values(areas).map(a => a.x))
  let y = top
  for (const card of ideas) {
    nodes[card.id] = map.nodes[card.id] ?? { x: minX - COL_W - AREA_GAP, y }
    y += estimateHeight(card) + GAP
  }
  return { areas, nodes }
}
