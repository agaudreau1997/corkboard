// A card: read it, and change it (title and description, list, complete, archived), with the
// question when it was edited elsewhere meanwhile; restore it from the archive; share it, and copy
// its id with a tap.

import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Card, ListDef } from '@shared/types'
import { SignedOut } from '../github/session'
import { Conflict, type CardChange } from '../repo/editor'
import { CardShare, CopyId } from './CardShare'
import { formatDue, Header, markdownParts } from './parts'

type ChangeCard = (change: CardChange, overwrite?: boolean) => Promise<void>

/** A card: read it, edit its title and description, move it, mark it complete, archive it. */
export function CardView(props: {
  card?: Card
  id: string
  lists: ListDef[]
  canChange: boolean
  /** A work project: what's shared names the card's Jira key, never its id. */
  work: boolean
  onBack: () => void
  onChange: ChangeCard
}) {
  const { card, id, lists, canChange, work, onBack, onChange } = props
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [conflict, setConflict] = useState<{ theirs: Card; change: CardChange }>()
  const [archiving, setArchiving] = useState(false)

  async function save(change: CardChange, overwrite = false) {
    setBusy(true)
    setError(undefined)
    try {
      await onChange(change, overwrite)
      setConflict(undefined)
      setEditing(false)
    } catch (e) {
      if (e instanceof Conflict) setConflict({ theirs: e.theirs, change })
      else if (e instanceof TypeError) setError('No connection: nothing was saved.')
      else if (!(e instanceof SignedOut)) setError((e as Error).message)
    } finally {
      setBusy(false)
      setArchiving(false)
    }
  }

  if (!card) {
    return (
      <>
        <Header title={id} onBack={onBack} />
        <p className="note">This card isn’t on the board any more.</p>
      </>
    )
  }

  if (editing) {
    return (
      <>
        <Header title={`Edit ${id}`} onBack={() => setEditing(false)} busy={busy} />
        <form
          className="page new-card"
          onSubmit={e => {
            e.preventDefault()
            const change: CardChange = {}
            if (title.trim() && title.trim() !== card.title) change.title = title.trim()
            if (body !== card.body) change.body = body
            if (Object.keys(change).length) void save(change)
            else setEditing(false)
          }}
        >
          <input placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} />
          <textarea placeholder="Description (Markdown)" value={body} onChange={e => setBody(e.target.value)} rows={14} />
          {error && <p className="note error">{error}</p>}
          {conflict && <ConflictNote conflict={conflict} busy={busy} onOverwrite={() => save(conflict.change, true)} onKeep={() => { setConflict(undefined); setEditing(false) }} />}
          <button className="primary" type="submit" disabled={busy || !title.trim()}>
            Save
          </button>
        </form>
      </>
    )
  }

  const listTitle = lists.find(l => l.id === card.list)?.title
  return (
    <>
      <Header title={id} sub={listTitle} onBack={onBack} busy={busy} />
      <div className="page card-page">
        <h2>{card.title}</h2>
        <p className="card-meta">
          <CopyId id={card.id} />
          {card.jira && <CopyId id={card.jira} />}
          {card.archived && <span className="chip">Archived</span>}
          {card.complete && <span className="chip done">Done</span>}
          {card.due && <span className="chip">Due {formatDue(card.due)}</span>}
          {card.labels.map(l => (
            <span key={l} className="chip">
              {l}
            </span>
          ))}
        </p>
        {canChange ? (
          <div className="actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setTitle(card.title)
                setBody(card.body)
                setError(undefined)
                setEditing(true)
              }}
            >
              Edit
            </button>
            {card.archived ? (
              <button type="button" disabled={busy} onClick={() => save({ restore: true })}>
                {listTitle ? `Restore to ${listTitle}` : 'Restore as an idea'}
              </button>
            ) : (
              <>
                <select
                  aria-label="Move to list"
                  disabled={busy}
                  value=""
                  onChange={e => e.target.value && void save({ list: e.target.value })}
                >
                  <option value="">Move to…</option>
                  {lists
                    .filter(l => l.id !== card.list)
                    .map(l => (
                      <option key={l.id} value={l.id}>
                        {l.title}
                      </option>
                    ))}
                </select>
                <button type="button" disabled={busy} onClick={() => save({ complete: !card.complete })}>
                  {card.complete ? 'Not complete' : 'Mark complete'}
                </button>
                {archiving ? (
                  <button type="button" className="danger" disabled={busy} onClick={() => save({ archived: true })}>
                    Archive it
                  </button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => setArchiving(true)}>
                    Archive
                  </button>
                )}
              </>
            )}
            <CardShare card={card} work={work} disabled={busy} />
          </div>
        ) : (
          <>
            <div className="actions">
              <CardShare card={card} work={work} />
            </div>
            <p className="note">Changing a card needs a connection to GitHub.</p>
          </>
        )}
        {error && <p className="note error">{error}</p>}
        {conflict && <ConflictNote conflict={conflict} busy={busy} onOverwrite={() => save(conflict.change, true)} onKeep={() => setConflict(undefined)} />}
        <div className="markdown">
          {card.body.trim() ? (
            <Markdown remarkPlugins={[remarkGfm]} components={markdownParts}>
              {card.body}
            </Markdown>
          ) : (
            <p className="note">No description.</p>
          )}
        </div>
      </div>
    </>
  )
}

/** Someone else edited the card's title or description meanwhile: overwrite it, or keep theirs. */
function ConflictNote(props: { conflict: { theirs: Card }; busy: boolean; onOverwrite: () => void; onKeep: () => void }) {
  const { theirs } = props.conflict
  return (
    <div className="conflict">
      <p>
        {theirs.id} was edited elsewhere since you opened it. It now reads <strong>{theirs.title}</strong>
        {theirs.body.trim() ? ', with a different description' : ''}.
      </p>
      <div className="actions">
        <button type="button" disabled={props.busy} onClick={props.onOverwrite}>
          Overwrite with mine
        </button>
        <button type="button" disabled={props.busy} onClick={props.onKeep}>
          Keep theirs
        </button>
      </div>
    </div>
  )
}
