import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../state'

export type MenuItem =
  | 'separator'
  | { heading: string }
  | {
      label: string
      hint?: string
      danger?: boolean
      disabled?: boolean
      checked?: boolean
      onSelect?: () => void
      items?: MenuItem[]
    }

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: MenuItem[]) {
  e.preventDefault()
  e.stopPropagation()
  useStore.setState({ contextMenu: { x: e.clientX, y: e.clientY, items } })
}

export function closeContextMenu() {
  useStore.setState({ contextMenu: null })
}

/** The one context menu of the app, opened by `openContextMenu` from any right-click. */
export function ContextMenuHost() {
  const menu = useStore(s => s.contextMenu)
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeContextMenu()
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.ctx-menu')) closeContextMenu()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', closeContextMenu)
    window.addEventListener('resize', closeContextMenu)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', closeContextMenu)
      window.removeEventListener('resize', closeContextMenu)
    }
  }, [menu])
  if (!menu) return null
  return <MenuPanel items={menu.items} x={menu.x} y={menu.y} />
}

function MenuPanel({ items, x, y, flipFrom }: { items: MenuItem[]; x: number; y: number; flipFrom?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [open, setOpen] = useState<{ index: number; x: number; y: number; flip: number } | null>(null)

  // Keep the panel on screen: shift it up, and open it leftwards when there is no room on the right.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    let left = x
    if (left + width > window.innerWidth - 6) left = flipFrom !== undefined ? flipFrom - width : window.innerWidth - width - 6
    const top = Math.max(6, Math.min(y, window.innerHeight - height - 6))
    setPos({ left: Math.max(6, left), top })
  }, [x, y, flipFrom, items])

  return (
    <>
      <div className="ctx-menu" role="menu" ref={ref} style={pos} onContextMenu={e => e.preventDefault()}>
        {items.map((item, index) => {
          if (item === 'separator') return <hr key={index} />
          if ('heading' in item)
            return (
              <div key={index} className="ctx-heading">
                {item.heading}
              </div>
            )
          const hasSub = !!item.items?.length
          return (
            <button
              key={index}
              role="menuitem"
              className={`${item.danger ? 'danger' : ''}${open?.index === index ? ' hot' : ''}`}
              disabled={item.disabled}
              aria-haspopup={hasSub ? 'menu' : undefined}
              onMouseEnter={e => {
                if (!hasSub) return setOpen(null)
                const r = e.currentTarget.getBoundingClientRect()
                setOpen({ index, x: r.right - 2, y: r.top - 5, flip: r.left + 2 })
              }}
              onClick={e => {
                if (hasSub) {
                  const r = e.currentTarget.getBoundingClientRect()
                  setOpen({ index, x: r.right - 2, y: r.top - 5, flip: r.left + 2 })
                  return
                }
                closeContextMenu()
                item.onSelect?.()
              }}
            >
              <span className="ctx-check">{item.checked ? '✓' : ''}</span>
              <span className="ctx-label">{item.label}</span>
              {item.hint && <span className="ctx-hint">{item.hint}</span>}
              {hasSub && <span className="ctx-arrow">▸</span>}
            </button>
          )
        })}
      </div>
      {open && (() => {
        const item = items[open.index]
        return item !== 'separator' && !('heading' in item) && item.items ? (
          <MenuPanel key={open.index} items={item.items} x={open.x} y={open.y} flipFrom={open.flip} />
        ) : null
      })()}
    </>
  )
}
