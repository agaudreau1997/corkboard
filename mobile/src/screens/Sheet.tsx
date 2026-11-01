// A sheet that slides up from the bottom over the screen, with a row per choice: the phone's menu
// (a card's share and copy choices, a list's settings). A tap outside it, or a choice, closes it.
// And a short confirmation that floats above the page, for a copy that otherwise shows nothing.

import { useEffect, useState, type ReactNode } from 'react'
import './sheet.css'

export function Sheet({ title, onClose, children }: { title?: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="menu" aria-label={title} onClick={e => e.stopPropagation()}>
        {title && <p className="sheet-title">{title}</p>}
        {children}
      </div>
    </div>
  )
}

/** One choice of a sheet; `hint` shows what it will do, dimmed beside it. */
export function SheetItem(props: { label: string; hint?: string; danger?: boolean; checked?: boolean; disabled?: boolean; onSelect: () => void }) {
  const { label, hint, danger, checked, disabled, onSelect } = props
  return (
    <button type="button" role="menuitem" className={danger ? 'sheet-item danger' : 'sheet-item'} disabled={disabled} onClick={onSelect}>
      <span className="sheet-check">{checked ? '✓' : ''}</span>
      <span className="sheet-label">{label}</span>
      {hint && <span className="sheet-hint">{hint}</span>}
    </button>
  )
}

/** A message shown for a moment, and a way to show one. */
export function useToast(): [ReactNode, (text: string) => void] {
  const [text, setText] = useState<string>()
  useEffect(() => {
    if (!text) return
    const timer = setTimeout(() => setText(undefined), 2000)
    return () => clearTimeout(timer)
  }, [text])
  return [text ? <p className="toast" role="status">{text}</p> : null, setText]
}
