// A layer that slides in over the board from one side, on a scrim that dims the board: the side
// panel from the left, a card's drawer from the right, as the desktop lays them out beside the
// board. A tap on the scrim closes it, and so does a finger pushing it back out the way it came,
// which it follows; a vertical move is left to the layer's own scrolling. The left one also opens
// from a swipe in from the screen's edge (`inPanelEdge`), drawn as it comes. What it showed stays
// while it slides out. Where its content scrolls across (a code block, a table), a swipe scrolls
// that instead.

import { useEffect, useRef, useState, type ReactNode, type TouchEvent as ReactTouchEvent } from 'react'
import { inPanelEdge, lockAxis, pushOut, settles, type Axis } from '../gestures'
import './slide.css'

/** How long the layer takes to slide, in ms: as `.slide`'s transition says. */
const SLIDE_MS = 220

type Track = { x: number; y: number; t: number; axis?: Axis }

export function Slide(props: {
  side: 'left' | 'right'
  open: boolean
  label: string
  className?: string
  /** Given, a swipe in from the left edge opens it. */
  onOpen?: () => void
  onClose: () => void
  children: ReactNode
}) {
  const { side, open, label, className, onOpen, onClose, children } = props
  const ref = useRef<HTMLElement>(null)
  /** How far the finger has moved the layer from where it rests, in px. */
  const [drag, setDrag] = useState<number>()
  const track = useRef<Track | undefined>(undefined)

  // What it showed, kept while it slides out.
  const shown = useRef<ReactNode>(open ? children : null)
  if (open) shown.current = children
  const [leaving, setLeaving] = useState(false)
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current === open) return
    wasOpen.current = open
    if (open) return setLeaving(false)
    setLeaving(true)
    const timer = setTimeout(() => {
      setLeaving(false)
      shown.current = null
    }, SLIDE_MS)
    return () => clearTimeout(timer)
  }, [open])

  // The swipe in from the left edge, watched on the whole page while the layer is shut.
  useEffect(() => {
    if (open || !onOpen) return
    let start: Track | undefined
    const down = (e: TouchEvent) => {
      const t = e.touches[0]
      start = e.touches.length === 1 && inPanelEdge(t.clientX) && !scrollsAcross(e.target) ? { x: t.clientX, y: t.clientY, t: e.timeStamp } : undefined
    }
    const move = (e: TouchEvent) => {
      if (!start) return
      const t = e.touches[0]
      const dx = t.clientX - start.x
      start.axis ??= lockAxis(dx, t.clientY - start.y)
      if (start.axis === 'y') start = undefined
      else if (start.axis === 'x') setDrag(Math.max(0, dx))
    }
    const up = (e: TouchEvent) => {
      if (!start) return
      const dx = (e.changedTouches[0]?.clientX ?? start.x) - start.x
      const width = ref.current?.offsetWidth ?? 300
      if (start.axis === 'x' && dx > 0 && settles(dx, e.timeStamp - start.t, width)) onOpen()
      start = undefined
      setDrag(undefined)
    }
    document.addEventListener('touchstart', down, { passive: true })
    document.addEventListener('touchmove', move, { passive: true })
    document.addEventListener('touchend', up)
    document.addEventListener('touchcancel', up)
    return () => {
      document.removeEventListener('touchstart', down)
      document.removeEventListener('touchmove', move)
      document.removeEventListener('touchend', up)
      document.removeEventListener('touchcancel', up)
    }
  }, [open, onOpen])

  // A finger pushing the open layer back out.
  const handlers = {
    onTouchStart(e: ReactTouchEvent) {
      const t = e.touches[0]
      track.current = e.touches.length === 1 && !scrollsAcross(e.target, ref.current) ? { x: t.clientX, y: t.clientY, t: e.timeStamp } : undefined
    },
    onTouchMove(e: ReactTouchEvent) {
      const start = track.current
      if (!start) return
      const t = e.touches[0]
      const dx = t.clientX - start.x
      start.axis ??= lockAxis(dx, t.clientY - start.y)
      if (start.axis === 'y') track.current = undefined
      else if (start.axis === 'x') setDrag(pushOut(side, dx))
    },
    onTouchEnd(e: ReactTouchEvent) {
      const start = track.current
      track.current = undefined
      if (!start) return
      const dx = pushOut(side, (e.changedTouches[0]?.clientX ?? start.x) - start.x)
      setDrag(undefined)
      if (start.axis === 'x' && dx && settles(dx, e.timeStamp - start.t, ref.current?.offsetWidth ?? 300)) onClose()
    },
  }

  const width = ref.current?.offsetWidth ?? 0
  // Shut, a drag from the edge pulls it in from off screen; open, a drag pushes it out.
  const offset = open ? (drag ?? 0) : drag !== undefined ? drag - width : undefined
  const style = offset === undefined ? undefined : { transform: `translateX(${offset}px)`, transition: drag === undefined ? undefined : 'none' }
  const shade = width && drag !== undefined ? (open ? 1 - Math.abs(drag) / width : drag / width) : undefined
  const visible = open || leaving || drag !== undefined

  return (
    <div className={`slide-layer${visible ? ' visible' : ''}`}>
      <div
        className={`slide-scrim${open ? ' open' : ''}`}
        style={shade === undefined ? undefined : { opacity: Math.max(0, Math.min(1, shade)), transition: 'none' }}
        onClick={onClose}
      />
      <aside
        ref={ref}
        className={`slide slide-${side}${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
        aria-label={label}
        aria-hidden={!open}
        style={style}
        {...handlers}
        onTouchCancel={handlers.onTouchEnd}
      >
        {open || drag !== undefined ? children : shown.current}
      </aside>
    </div>
  )
}

/** Whether a touch landed in something that scrolls across (a code block, a table, the tabs), up to `root`. */
function scrollsAcross(target: EventTarget | null, root?: Element | null): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== root; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true
  }
  return false
}
