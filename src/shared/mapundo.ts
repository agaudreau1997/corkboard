// The map's undo and redo, as data: a step is what one gesture on the map changed, the map.json
// before and after it and the card fields it wrote with their old values. Replaying a step (back
// for undo, forward for redo) is a merge, not a restore: only what the step itself changed is put
// back, and only where it still stands as the step left it. A card or a position changed since by
// someone else (the drawer, a session, another machine) is left alone and counted as skipped, so an
// undo never takes back work it did not do.

import type { BoardMap, Card } from './types'

export type CardChange = { id: string; before: Partial<Card>; after: Partial<Card> }

export type MapStep = {
  /** What the step did, for the toast an undo shows ("move a card"). */
  label: string
  map?: { before: BoardMap; after: BoardMap }
  cards: CardChange[]
}

export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a).filter(k => (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b).filter(k => (b as Record<string, unknown>)[k] !== undefined)
  if (ka.length !== kb.length) return false
  return ka.every(k => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** Whether a step changes anything at all (a drag that ends where it started does not). */
export function isEmptyStep(step: MapStep): boolean {
  return (!step.map || same(step.map.before, step.map.after)) && step.cards.every(c => same(c.before, c.after))
}

type Keyed = 'nodes' | 'areas'
const KEYED: Keyed[] = ['nodes', 'areas']
const WHOLE = ['hiddenLists', 'showUnlisted'] as const

/**
 * Moves the map from `from` to `to`, in what changed between the two, on top of the map as it is
 * now. `skipped` counts what was changed since and so left as it is.
 */
export function replayMap(current: BoardMap, from: BoardMap, to: BoardMap): { map: BoardMap; skipped: number } {
  const map: BoardMap = { ...current, nodes: { ...current.nodes }, areas: current.areas && { ...current.areas } }
  let skipped = 0
  for (const key of KEYED) {
    const f = from[key] ?? {}
    const t = to[key] ?? {}
    for (const id of new Set([...Object.keys(f), ...Object.keys(t)])) {
      if (same(f[id], t[id])) continue
      const now = current[key]?.[id]
      if (same(now, t[id])) continue
      if (!same(now, f[id])) {
        skipped++
        continue
      }
      const target = (map[key] ??= {}) as Record<string, unknown>
      if (t[id] === undefined) delete target[id]
      else target[id] = t[id]
    }
  }
  for (const key of WHOLE) {
    if (same(from[key], to[key]) || same(current[key], to[key])) continue
    if (!same(current[key], from[key])) skipped++
    else if (to[key] === undefined) delete map[key]
    else (map as Record<string, unknown>)[key] = to[key]
  }
  return { map, skipped }
}

/**
 * The patch that takes a card from `from` to `to`: null when it was changed since in one of those
 * fields (it is left alone), empty when it is already there.
 */
export function replayCard(current: Card, from: Partial<Card>, to: Partial<Card>): Partial<Card> | null {
  const patch: Partial<Card> = {}
  for (const key of Object.keys(to) as (keyof Card)[]) {
    if (same(current[key], to[key])) continue
    if (!same(current[key], from[key])) return null
    ;(patch as Record<string, unknown>)[key] = to[key]
  }
  return patch
}
