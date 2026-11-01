// The decisions behind the companion's swipes, kept apart from the screens so they can be tested:
// which way a touch is going, where a swipe may start, and whether a released one goes through.
//
// Three swipes share the screen. A swipe in from the left edge opens the side panel; a swipe along
// a list goes to the next or the previous list; a drawer or the panel follows a finger that pushes
// it back out. Android's gesture navigation takes a swipe in from either edge as *back*, before
// the app sees it, and how wide that strip is depends on the phone. So the panel's edge zone is a
// band wider than any system strip (the app gets whatever the system leaves of it), and a list
// swipe never starts in that band, nor near the right edge, so neither fights the other or Android.

/** How wide the band along the left edge is that opens the side panel, in CSS pixels. */
export const PANEL_EDGE = 40

/** How near the right edge a list swipe may not start: Android's back gesture is there too. */
export const RIGHT_EDGE = 24

/** How far a finger moves before its direction is decided. */
export const SLOP = 10

export type Axis = 'x' | 'y'

/**
 * The direction a touch has taken once it moved past the slop: across ('x') only when clearly more
 * across than down, so a slightly slanted scroll stays a scroll. None before that.
 */
export function lockAxis(dx: number, dy: number, slop = SLOP): Axis | undefined {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < slop) return undefined
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y'
}

/** Whether a touch at `x` starts in the band that opens the side panel. */
export function inPanelEdge(x: number): boolean {
  return x < PANEL_EDGE
}

/** Whether a list swipe may start at `x`, on a screen `width` wide: clear of both edges. */
export function listSwipeStarts(x: number, width: number): boolean {
  return x >= PANEL_EDGE && x <= width - RIGHT_EDGE
}

/**
 * Whether a released swipe goes through: past a third of `size` (the list's or the drawer's
 * width), or flung (quick, and past a short distance) whatever its length.
 */
export function settles(distance: number, ms: number, size: number): boolean {
  const d = Math.abs(distance)
  return d >= size / 3 || (d >= 40 && d / Math.max(ms, 1) >= 0.5)
}

/** -1 for the previous list, 1 for the next: a finger moving left brings in the next. */
export type Step = -1 | 1

/** The step a swipe across `dx` asks for. */
export function stepOf(dx: number): Step {
  return dx < 0 ? 1 : -1
}

/** The list a step lands on, or none past either end. */
export function stepTo(index: number, count: number, step: Step): number | undefined {
  const next = index + step
  return index >= 0 && next >= 0 && next < count ? next : undefined
}

/** How far the content follows the finger: all the way, or a third of it where there's nothing to go to. */
export function follow(dx: number, canGo: boolean): number {
  return canGo ? dx : dx / 3
}

/**
 * How far a drawer that slides in from `side` is pushed back out by a finger moved `dx` across:
 * only the way it closes, never further in than open.
 */
export function pushOut(side: 'left' | 'right', dx: number): number {
  return side === 'left' ? Math.min(0, dx) : Math.max(0, dx)
}
