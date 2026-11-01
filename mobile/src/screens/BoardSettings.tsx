// A board's settings, what of them applies on a phone: its title, its lists (their colours, names
// and order, adding one, archiving and restoring), and the flow (the lists tackling and finishing
// move cards to). The code repo and prompt notes are for Claude sessions, which the phone doesn't
// start: shown, not edited. Each change is written at once, one commit each, like the desktop's.

import { useState } from 'react'
import { LIST_COLORS, listColorAt } from '@shared/cardfile'
import type { BoardMeta, ListDef } from '@shared/types'
import type { BoardChange } from '../repo/boardchange'
import { AskText } from './ListMenu'
import { Header } from './parts'
import { Sheet, SheetItem } from './Sheet'
import './boardsettings.css'

type Asking = { kind: 'title' } | { kind: 'add' } | { kind: 'rename'; list: ListDef } | { kind: 'color'; list: ListDef; color: string }

export function BoardSettings(props: {
  meta: BoardMeta
  /** Live cards per list, for the list rows. */
  counts: Map<string, number>
  canChange: boolean
  busy: boolean
  error?: string
  onBack: () => void
  onChange: (change: BoardChange) => void
}) {
  const { meta, counts, canChange, busy, error, onBack, onChange } = props
  const [asking, setAsking] = useState<Asking>()
  const off = !canChange || busy
  const ask = (a: Asking) => !off && setAsking(a)
  const done = (change: BoardChange) => {
    setAsking(undefined)
    onChange(change)
  }
  const live = meta.lists.filter(l => !l.archived)

  return (
    <>
      <Header title="Board settings" sub={meta.title} onBack={onBack} busy={busy} />
      <div className="page settings-page">
        {!canChange && <p className="note">Changing the board needs a connection to GitHub.</p>}
        {error && <p className="note error">{error}</p>}

        <h3>Title</h3>
        <button type="button" className="settings-row" disabled={off} onClick={() => ask({ kind: 'title' })}>
          <span className="settings-main">{meta.title}</span>
          <span className="settings-hint">{meta.key}</span>
        </button>

        <h3>Lists</h3>
        <ul className="settings-lists">
          {meta.lists.map((list, i) => (
            <li key={list.id} className={list.archived ? 'archived' : undefined}>
              <button
                type="button"
                className="swatch"
                aria-label={`Colour of ${list.title}`}
                disabled={off || list.archived}
                style={{ background: listColorAt(meta.lists, i) }}
                onClick={() => ask({ kind: 'color', list, color: listColorAt(meta.lists, i) })}
              />
              <button type="button" className="settings-name" disabled={off} onClick={() => ask({ kind: 'rename', list })}>
                <span className="settings-main">{list.title}</span>
                <span className="settings-hint">
                  {list.id} · {counts.get(list.id) ?? 0}
                </span>
              </button>
              {list.archived ? (
                <button type="button" className="settings-action" disabled={off} onClick={() => onChange({ kind: 'restoreList', list: list.id })}>
                  Restore
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="settings-action"
                    aria-label={`Move ${list.title} up`}
                    disabled={off || live[0]?.id === list.id}
                    onClick={() => onChange({ kind: 'moveList', list: list.id, by: -1 })}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="settings-action"
                    disabled={off}
                    onClick={() => onChange({ kind: 'archiveList', list: list.id })}
                  >
                    Archive
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        <button type="button" className="settings-add" disabled={off} onClick={() => ask({ kind: 'add' })}>
          + Add a list
        </button>

        <h3>Flow</h3>
        <label className="settings-field">
          <span>Tackling moves cards to</span>
          <select
            value={meta.flow?.doing ?? ''}
            disabled={off}
            onChange={e => onChange({ kind: 'flow', doing: e.target.value || null })}
          >
            <option value="">(leave them where they are)</option>
            {live.map(l => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-field">
          <span>Claude moves finished cards to</span>
          <select value={meta.flow?.done ?? ''} disabled={off} onChange={e => onChange({ kind: 'flow', done: e.target.value || null })}>
            <option value="">(nowhere: I move them)</option>
            {live.map(l => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        </label>

        {(meta.codeRepo || meta.promptNotes) && (
          <>
            <h3>For Claude sessions</h3>
            <p className="note">Set on the desktop, where the sessions start.</p>
            {meta.codeRepo && (
              <p className="settings-readonly">
                <span>Code repo</span>
                <code>{meta.codeRepo}</code>
              </p>
            )}
            {meta.promptNotes && (
              <p className="settings-readonly">
                <span>Prompt notes</span>
                {meta.promptNotes}
              </p>
            )}
          </>
        )}
      </div>

      {asking?.kind === 'title' && (
        <AskText title="Board title" value={meta.title} action="Rename" onClose={() => setAsking(undefined)} onDone={title => done({ kind: 'title', title })} />
      )}
      {asking?.kind === 'add' && (
        <AskText title="Add a list" value="" action="Add list" onClose={() => setAsking(undefined)} onDone={title => done({ kind: 'addList', title })} />
      )}
      {asking?.kind === 'rename' && (
        <AskText
          title={`Rename ${asking.list.title}`}
          value={asking.list.title}
          action="Rename"
          onClose={() => setAsking(undefined)}
          onDone={title => done({ kind: 'renameList', list: asking.list.id, title })}
        />
      )}
      {asking?.kind === 'color' && (
        <Sheet title={`Colour of ${asking.list.title}`} onClose={() => setAsking(undefined)}>
          <div className="palette">
            {LIST_COLORS.map(color => (
              <button
                key={color}
                type="button"
                className={color.toLowerCase() === asking.color.toLowerCase() ? 'swatch big current' : 'swatch big'}
                aria-label={color}
                style={{ background: color }}
                onClick={() => done({ kind: 'colorList', list: asking.list.id, color })}
              />
            ))}
          </div>
          <SheetItem label="Cancel" onSelect={() => setAsking(undefined)} />
        </Sheet>
      )}
    </>
  )
}
