import { useEffect, useRef, useState } from 'react'
import type { TackleMode } from '@shared/types'

type Split = 'together' | 'each'

/**
 * The tackle dropdown. One card: locally, in a worktree, in the cloud. Several cards (a
 * selection or a whole list): one local session for all, one worktree session each, or one
 * cloud session for all.
 */
export function TackleMenu({
  label,
  many,
  onPick,
  compact,
}: {
  label: string
  many: boolean
  onPick: (mode: TackleMode, split?: Split) => void
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const pick = (mode: TackleMode, split?: Split) => {
    setOpen(false)
    onPick(mode, split)
  }

  return (
    <div className="menu-anchor" ref={ref}>
      <button
        className={compact ? 'ghost small' : 'accent'}
        onClick={e => {
          e.stopPropagation()
          setOpen(o => !o)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label} ▾
      </button>
      {open && (
        <div className="menu" role="menu" onClick={e => e.stopPropagation()}>
          {many ? (
            <>
              <button role="menuitem" onClick={() => pick('local', 'together')}>
                <strong>Locally, one session</strong>
                <small>All cards in one Claude Code session, in order</small>
              </button>
              <button role="menuitem" onClick={() => pick('local-worktree', 'each')}>
                <strong>Locally, in parallel</strong>
                <small>One session per card, each in its own worktree</small>
              </button>
              <button role="menuitem" onClick={() => pick('cloud', 'together')}>
                <strong>In Claude Cloud</strong>
                <small>One cloud session for all the cards</small>
              </button>
            </>
          ) : (
            <>
              <button role="menuitem" onClick={() => pick('local')}>
                <strong>Locally</strong>
                <small>A Claude Code session in the code repo</small>
              </button>
              <button role="menuitem" onClick={() => pick('local-worktree')}>
                <strong>Locally, in a worktree</strong>
                <small>Its own branch and folder, beside other work</small>
              </button>
              <button role="menuitem" onClick={() => pick('cloud')}>
                <strong>In Claude Cloud</strong>
                <small>A claude.ai/code session on the pushed branch</small>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
