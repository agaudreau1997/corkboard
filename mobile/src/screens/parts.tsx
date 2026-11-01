// Pieces every screen shares: the header with its menu or back button and its refresh, the page
// that refreshes when pulled down (and on a board, swipes to the next list), how a card's
// description renders, and small wordings.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { type Components } from 'react-markdown'
import { Browser } from '@capacitor/browser'
import { follow, listSwipeStarts, lockAxis, settles, stepOf, type Axis, type Step } from '../gestures'
import { Icon } from '../Icon'
import { CardImage } from './CardImage'
import './parts.css'

/** A screen's header: the side panel's menu or back, the titles, and refresh where it can be refreshed. */
export function Header(props: {
  title: string
  sub?: string
  /** Given, a hamburger at the left opens the side panel (a board's header). */
  onMenu?: () => void
  onBack?: () => void
  busy?: boolean
  /** Before the title: the repo's icon or swatch. */
  mark?: ReactNode
  onRefresh?: () => void
}) {
  const { title, sub, onMenu, onBack, busy, mark, onRefresh } = props
  return (
    <header className="header">
      {onMenu && (
        <button className="back" type="button" onClick={onMenu} aria-label="Boards and repos">
          <Icon name="menu" />
        </button>
      )}
      {onBack && (
        <button className="back" type="button" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" />
        </button>
      )}
      {mark}
      <div className="titles">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {onRefresh ? (
        <button className="refresh" type="button" onClick={onRefresh} disabled={busy} aria-label={busy ? 'Refreshing' : 'Refresh'}>
          {busy ? <span className="spinner" /> : <Icon name="refresh" />}
        </button>
      ) : (
        busy && <span className="spinner" aria-label="Refreshing" />
      )}
    </header>
  )
}

/** What a page needs to swipe between lists: where it is, and the way to the next or previous. */
export type Swipe = {
  /** The list shown: a new one starts at the top, sliding in from the side it was swiped from. */
  key: string
  canGo: (step: Step) => boolean
  go: (step: Step) => void
}

type Touch = { x: number; y: number; t: number; axis?: Axis; top: boolean; across: boolean }

/**
 * A scrolling page that refreshes when pulled down from its top; given a `swipe`, a finger moving
 * across it brings in the next or the previous list, the page following it as it goes. Which of
 * the two a touch is decides once it has moved (`lockAxis`), so a scroll never turns into a swipe.
 */
export function Pull({ onRefresh, swipe, children }: { onRefresh?: () => Promise<void>; swipe?: Swipe; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const touch = useRef<Touch | undefined>(undefined)
  const [pulled, setPulled] = useState(0)
  const [dx, setDx] = useState(0)
  /** The way the list just shown came in, for its slide. */
  const [entered, setEntered] = useState<Step>()
  const THRESHOLD = 70

  // Another list starts at its top.
  const key = swipe?.key
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0
  }, [key])

  return (
    <div
      ref={ref}
      className={swipe ? 'page swipes' : 'page'}
      onTouchStart={e => {
        const t = e.touches[0]
        touch.current =
          e.touches.length === 1
            ? {
                x: t.clientX,
                y: t.clientY,
                t: e.timeStamp,
                top: !!onRefresh && ref.current?.scrollTop === 0,
                across: !!swipe && listSwipeStarts(t.clientX, window.innerWidth),
              }
            : undefined
      }}
      onTouchMove={e => {
        const start = touch.current
        if (!start) return
        const t = e.touches[0]
        const moved = t.clientX - start.x
        start.axis ??= lockAxis(moved, t.clientY - start.y)
        if (start.axis === 'y' && start.top) setPulled(Math.max(0, Math.min(120, t.clientY - start.y)))
        else if (start.axis === 'x' && start.across && swipe) setDx(follow(moved, swipe.canGo(stepOf(moved))))
      }}
      onTouchEnd={e => {
        const start = touch.current
        touch.current = undefined
        if (pulled >= THRESHOLD) void onRefresh?.()
        setPulled(0)
        setDx(0)
        if (!start || start.axis !== 'x' || !start.across || !swipe) return
        const moved = (e.changedTouches[0]?.clientX ?? start.x) - start.x
        const step = stepOf(moved)
        if (settles(moved, e.timeStamp - start.t, ref.current?.clientWidth ?? window.innerWidth) && swipe.canGo(step)) {
          setEntered(step)
          swipe.go(step)
        }
      }}
      onTouchCancel={() => {
        touch.current = undefined
        setPulled(0)
        setDx(0)
      }}
    >
      {pulled > 0 && (
        <div className="pull" style={{ height: pulled }}>
          {pulled >= THRESHOLD ? 'Release to refresh' : 'Pull to refresh'}
        </div>
      )}
      {swipe ? (
        <div
          key={swipe.key}
          className={entered ? `swipe-content enter-${entered > 0 ? 'next' : 'previous'}` : 'swipe-content'}
          style={dx ? { transform: `translateX(${dx}px)`, transition: 'none' } : undefined}
          onAnimationEnd={() => setEntered(undefined)}
        >
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )
}

export const markdownParts: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={e => {
        e.preventDefault()
        if (href && /^https?:/.test(href)) void Browser.open({ url: href })
      }}
    >
      {children}
    </a>
  ),
  // Images in descriptions are the board repo's own files, named relative to the card file.
  img: ({ src, alt }) => <CardImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
}

export function count(n: number): string {
  return `${n} card${n === 1 ? '' : 's'}`
}

export function formatDue(due: string): string {
  const date = new Date(due)
  return Number.isNaN(date.getTime()) ? due : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
