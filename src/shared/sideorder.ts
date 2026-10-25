// The side panel's order of projects and boards, dragged by their handles: this machine's, kept in
// the app config rather than the board repo, so a reorder never becomes a commit someone else
// pulls. It is a list of keys (project ids, board keys) and nothing more: whatever sibling list the
// tree shows is sorted by it, and anything it doesn't name (a board made since, or pulled in)
// keeps the place the tree gave it, by title, after the ones it names. A project's main board is
// picked by title, not by this order, so every machine agrees on it.

import type { SidebarOrder } from './types'

/** The items in the order's sequence, the ones it doesn't know after them in their given order. */
export function inOrder<T>(items: T[], keyOf: (item: T) => string, order: string[] | undefined): T[] {
  if (!order?.length) return items
  const rank = new Map(order.map((key, i) => [key, i]))
  const at = (item: T) => rank.get(keyOf(item)) ?? Infinity
  // Array.prototype.sort is stable, so the unknown ones keep the order they came in.
  return [...items].sort((a, b) => at(a) - at(b))
}

/**
 * The order after a sibling list was rearranged to `siblings`: those take the end, in their new
 * sequence, and every key not in `known` (a board deleted, or moved to another project) drops out.
 */
export function reordered(order: string[] | undefined, siblings: string[], known: Set<string>): string[] {
  const moved = new Set(siblings)
  return [...(order ?? []).filter(key => known.has(key) && !moved.has(key)), ...siblings]
}

/** The config's order with one part replaced; an empty list clears that part. */
export function patchOrder(order: SidebarOrder | undefined, patch: SidebarOrder): SidebarOrder {
  const next: SidebarOrder = { ...order, ...patch }
  if (!next.projects?.length) delete next.projects
  if (!next.boards?.length) delete next.boards
  return next
}
