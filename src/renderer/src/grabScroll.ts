import { useEffect, useRef, useState, type RefObject } from 'react'

// A list's header drags the list, so it never pans the board.
const INTERACTIVE = '.card, .divider-card, .column-head, button, input, textarea, select, a, [contenteditable], .ctx-menu'

/**
 * Drag the empty parts of a scroller to pan it, with a little momentum on release: sideways
 * across the board, and up and down inside the column under the pointer. Cards and controls keep
 * their own pointer handling (dnd-kit owns a card's drag).
 */
export function useGrabScroll(ref: RefObject<HTMLElement | null>) {
  const [grabbing, setGrabbing] = useState(false)
  const state = useRef<{
    id: number
    x: number
    y: number
    left: number
    top: number
    column: HTMLElement | null
    vx: number
    vy: number
    t: number
    moved: boolean
  } | null>(null)
  const glide = useRef(0)

  useEffect(() => () => cancelAnimationFrame(glide.current), [])

  const onPointerDown = (e: React.PointerEvent) => {
    const el = ref.current
    if (!el || e.button !== 0 || (e.target as HTMLElement).closest(INTERACTIVE)) return
    cancelAnimationFrame(glide.current)
    const column = (e.target as HTMLElement).closest('.column-body') as HTMLElement | null
    state.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: el.scrollLeft,
      top: column?.scrollTop ?? 0,
      column,
      vx: 0,
      vy: 0,
      t: performance.now(),
      moved: false,
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const s = state.current
    const el = ref.current
    if (!s || !el || s.id !== e.pointerId) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (!s.moved) {
      if (Math.hypot(dx, dy) < 4) return
      s.moved = true
      setGrabbing(true)
      el.setPointerCapture(e.pointerId)
    }
    const now = performance.now()
    const dt = Math.max(1, now - s.t)
    const prevLeft = el.scrollLeft
    const prevTop = s.column?.scrollTop ?? 0
    el.scrollLeft = s.left - dx
    if (s.column) s.column.scrollTop = s.top - dy
    s.vx = (el.scrollLeft - prevLeft) / dt
    s.vy = ((s.column?.scrollTop ?? 0) - prevTop) / dt
    s.t = now
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const s = state.current
    const el = ref.current
    state.current = null
    if (!s || !el || !s.moved) return
    setGrabbing(false)
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    // Momentum: keep going at the release speed, easing out.
    let vx = s.vx * 16
    let vy = s.vy * 16
    const step = () => {
      vx *= 0.92
      vy *= 0.92
      el.scrollLeft += vx
      if (s.column) s.column.scrollTop += vy
      if (Math.abs(vx) > 0.5 || Math.abs(vy) > 0.5) glide.current = requestAnimationFrame(step)
    }
    if (Math.abs(vx) > 1 || Math.abs(vy) > 1) glide.current = requestAnimationFrame(step)
  }

  return {
    grabbing,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  }
}
