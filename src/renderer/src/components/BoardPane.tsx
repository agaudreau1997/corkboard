import { useEffect, useMemo, useRef, useState } from 'react'
import type { Card } from '@shared/types'
import { actions, useStore, type ViewMode, NONE } from '../state'
import { KanbanView } from './KanbanView'
import { MapView } from './MapView'
import { TableView } from './TableView'
import { discussItems, tackleAllItems } from '../menus'
import { openContextMenu } from './ContextMenu'

const VIEWS: { id: ViewMode; label: string }[] = [
  { id: 'board', label: 'Board' },
  { id: 'map', label: 'Map' },
  { id: 'table', label: 'Table' },
]

export function BoardPane({ path }: { path: string }) {
  const board = useStore(s => s.boards[path])
  const view = useStore(s => s.tabs.find(t => t.path === path)?.view ?? 'board')
  const selected = useStore(s => s.selected[path] ?? NONE)
  const [filter, setFilter] = useState('')
  const filterInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return
      // Shells use Ctrl+F for "cursor forward"; leave it to the terminal.
      if (useStore.getState().modal || (e.target as Element | null)?.closest?.('.terminal-panel')) return
      e.preventDefault()
      filterInput.current?.focus()
      filterInput.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const matches = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return () => true
    return (card: Card) =>
      card.id.toLowerCase().includes(q) ||
      card.title.toLowerCase().includes(q) ||
      card.body.toLowerCase().includes(q)
  }, [filter])

  if (!board) return <div className="empty-state">Loading board…</div>

  return (
    <section className="board-pane">
      <header className="board-head">
        <h2>{board.meta.title}</h2>
        <span className="board-key">{board.meta.key}</span>
        <div className="segmented" role="tablist" aria-label="View">
          {VIEWS.map(v => (
            <button
              key={v.id}
              role="tab"
              aria-selected={view === v.id}
              className={view === v.id ? 'on' : ''}
              onClick={() => actions.setView(path, v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <input
          ref={filterInput}
          className="filter"
          type="search"
          placeholder="Filter cards (Ctrl+F)"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <div className="spacer" />
        {selected.length > 0 && (
          <div className="selection-bar">
            <span>{selected.length} selected</span>
            {/* One card is tackled or discussed from its own menu; these are for several. */}
            {selected.length > 1 && (
              <>
                <button
                  className="accent"
                  onClick={e => {
                    const r = e.currentTarget.getBoundingClientRect()
                    openContextMenu(
                      { clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} },
                      tackleAllItems(board, selected),
                    )
                  }}
                >
                  Tackle ▾
                </button>
                <button
                  onClick={e => {
                    const r = e.currentTarget.getBoundingClientRect()
                    openContextMenu(
                      { clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} },
                      discussItems(board, selected),
                    )
                  }}
                >
                  Discuss ▾
                </button>
              </>
            )}
            <button className="ghost" onClick={() => actions.clearSelection(path)}>
              Clear
            </button>
          </div>
        )}
        <button className="ghost" title="Open a shell in the board's code repo" onClick={() => void actions.newTerminal(path)}>
          Terminal
        </button>
        <button className="ghost" onClick={() => actions.setModal({ kind: 'settings', path })}>
          Settings
        </button>
      </header>
      {view === 'board' && <KanbanView board={board} matches={matches} />}
      {view === 'map' && <MapView board={board} matches={matches} />}
      {view === 'table' && <TableView board={board} matches={matches} />}
    </section>
  )
}
