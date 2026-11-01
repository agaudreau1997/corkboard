// Pieces every screen shares: the header with its back button, the page that refreshes when
// pulled down, how a card's description renders, and small wordings.

import { useRef, useState, type ReactNode } from 'react'
import { type Components } from 'react-markdown'
import { Browser } from '@capacitor/browser'

export function Header(props: {
  title: string
  sub?: string
  onBack?: () => void
  busy?: boolean
  /** Before the title: the repo's icon or swatch. */
  mark?: ReactNode
}) {
  const { title, sub, onBack, busy, mark } = props
  return (
    <header className="header">
      {onBack && (
        <button className="back" type="button" onClick={onBack} aria-label="Back">
          ‹
        </button>
      )}
      {mark}
      <div className="titles">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {busy && <span className="spinner" aria-label="Refreshing" />}
    </header>
  )
}

/** A scrolling page that refreshes when pulled down from its top. */
export function Pull({ onRefresh, children }: { onRefresh?: () => Promise<void>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const start = useRef<number | undefined>(undefined)
  const [pulled, setPulled] = useState(0)
  const THRESHOLD = 70
  return (
    <div
      ref={ref}
      className="page"
      onTouchStart={e => {
        start.current = onRefresh && ref.current?.scrollTop === 0 ? e.touches[0].clientY : undefined
      }}
      onTouchMove={e => {
        if (start.current !== undefined) setPulled(Math.max(0, Math.min(120, e.touches[0].clientY - start.current)))
      }}
      onTouchEnd={() => {
        if (pulled >= THRESHOLD) void onRefresh?.()
        start.current = undefined
        setPulled(0)
      }}
    >
      {pulled > 0 && (
        <div className="pull" style={{ height: pulled }}>
          {pulled >= THRESHOLD ? 'Release to refresh' : 'Pull to refresh'}
        </div>
      )}
      {children}
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
  // Images in descriptions are the board repo's own files, which the phone doesn't read yet.
  img: ({ alt }) => <span className="img-alt">[image{alt ? `: ${alt}` : ''}]</span>,
}

export function count(n: number): string {
  return `${n} card${n === 1 ? '' : 's'}`
}

export function formatDue(due: string): string {
  const date = new Date(due)
  return Number.isNaN(date.getTime()) ? due : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
