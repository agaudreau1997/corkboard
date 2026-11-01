// A card's details under its title, as the desktop's drawer has them: the due date, the labels, the
// linked cards and the *Do after*. Signed in, the due date, labels and *Do after* change from here,
// each a change of its own through `changeCard`; links only show (they're made on the desktop).
// The due date is the system's date picker, which shows a day: a time written by hand stays until
// another day is picked (`pickDue`). A label is picked from the ones the board uses, or typed. A
// card waited on is picked from the board's, leaving out any that would make the order loop.

import { useEffect, useState } from 'react'
import { cardNumber, isDivider } from '@shared/cardfile'
import { dueDay } from '@shared/due'
import { findCycle, unmetPrerequisites } from '@shared/tackleorder'
import type { Card } from '@shared/types'
import type { CardChange } from '../repo/editor'
import type { Linked } from '../repo/linked'
import { formatDue } from './parts'
import './carddetails.css'

export function CardDetails(props: {
  card: Card
  /** The open board's cards, the card's own among them. */
  cards: Card[]
  /** The board's done list (`flow.done`): a card waited on that's in it is done. */
  doneList?: string
  linked: Linked[]
  canChange: boolean
  busy: boolean
  onChange: (change: CardChange) => void
  onOpen: (linked: Linked) => void
}) {
  const { card, cards, doneList, linked, canChange, busy, onChange, onOpen } = props
  return (
    <div className="card-details">
      <Due card={card} canChange={canChange} busy={busy} onChange={onChange} />
      <Labels card={card} cards={cards} canChange={canChange} busy={busy} onChange={onChange} />
      {linked.length > 0 && (
        <section>
          <h3>Linked cards</h3>
          <ul className="detail-rows">
            {linked.map(l => (
              <li key={l.id}>
                <LinkedRow linked={l} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <After card={card} cards={cards} doneList={doneList} canChange={canChange} busy={busy} onChange={onChange} onOpen={onOpen} />
    </div>
  )
}

function Due(props: { card: Card; canChange: boolean; busy: boolean; onChange: (change: CardChange) => void }) {
  const { card, canChange, busy, onChange } = props
  const shown = card.due ? dueDay(card.due) : ''
  const [day, setDay] = useState(shown)
  useEffect(() => setDay(shown), [shown])
  // A time written by hand shows under the day, so it's clear what a new day would replace.
  const time = card.due && card.due !== shown ? card.due : undefined
  if (!canChange) {
    if (!card.due) return null
    return (
      <section>
        <h3>Due</h3>
        <p className="detail-text">{formatDue(card.due)}</p>
      </section>
    )
  }
  return (
    <section>
      <h3>Due</h3>
      <div className="due-row">
        <input
          type="date"
          aria-label="Due date"
          value={day}
          disabled={busy}
          onChange={e => {
            const value = e.target.value
            setDay(value)
            // The picker's own Clear empties it; a typed date passes through years like 0002.
            if (value === '') {
              if (card.due) onChange({ due: null })
            } else if (Number(value.slice(0, 4)) >= 1000 && value !== shown) {
              onChange({ due: value })
            }
          }}
        />
        {card.due && (
          <button type="button" className="remove" aria-label="Clear the due date" disabled={busy} onClick={() => onChange({ due: null })}>
            ×
          </button>
        )}
      </div>
      {time && <p className="detail-note">Written as {time}: kept until another day is picked.</p>}
    </section>
  )
}

function Labels(props: { card: Card; cards: Card[]; canChange: boolean; busy: boolean; onChange: (change: CardChange) => void }) {
  const { card, cards, canChange, busy, onChange } = props
  const [adding, setAdding] = useState(false)
  const [typed, setTyped] = useState('')
  useEffect(() => {
    setAdding(false)
    setTyped('')
  }, [card.labels.join()])
  if (!canChange && !card.labels.length) return null
  // The board's labels in use, the most used first, that the card doesn't have yet.
  const uses = new Map<string, number>()
  for (const c of cards) if (!c.archived) for (const l of c.labels) uses.set(l, (uses.get(l) ?? 0) + 1)
  const offered = [...uses.keys()].filter(l => !card.labels.includes(l)).sort((a, b) => uses.get(b)! - uses.get(a)! || a.localeCompare(b))
  const add = (label: string) => label.trim() && onChange({ labels: { add: [label.trim()] } })
  return (
    <section>
      <h3>Labels</h3>
      <div className="label-chips">
        {card.labels.map(l => (
          <span key={l} className="chip label">
            {l}
            {canChange && (
              <button type="button" className="remove" aria-label={`Remove the label ${l}`} disabled={busy} onClick={() => onChange({ labels: { remove: [l] } })}>
                ×
              </button>
            )}
          </span>
        ))}
        {canChange && !adding && (
          <button type="button" className="chip add" disabled={busy} onClick={() => setAdding(true)}>
            + Label
          </button>
        )}
      </div>
      {canChange && adding && (
        <div className="label-picker">
          <form
            onSubmit={e => {
              e.preventDefault()
              add(typed)
            }}
          >
            <input autoFocus placeholder="A new label" value={typed} disabled={busy} onChange={e => setTyped(e.target.value)} />
            <button type="submit" disabled={busy || !typed.trim()}>
              Add
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </form>
          {offered.length > 0 && (
            <div className="label-chips">
              {offered.map(l => (
                <button key={l} type="button" className="chip offer" disabled={busy} onClick={() => add(l)}>
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function LinkedRow({ linked, onOpen }: { linked: Linked; onOpen: (linked: Linked) => void }) {
  const note = linked.board
    ? linked.boardTitle && `on ${linked.boardTitle}${linked.card ? '' : ', not read on this phone yet'}`
    : 'not in this repo'
  return (
    <button type="button" className="detail-row" disabled={!linked.board} onClick={() => onOpen(linked)}>
      <span className="card-id">{linked.id}</span>
      <span className="detail-title">
        {linked.card?.title}
        {note && <span className="detail-note">{linked.card ? ` · ${note}` : note}</span>}
      </span>
    </button>
  )
}

function After(props: {
  card: Card
  cards: Card[]
  doneList?: string
  canChange: boolean
  busy: boolean
  onChange: (change: CardChange) => void
  onOpen: (linked: Linked) => void
}) {
  const { card, cards, doneList, canChange, busy, onChange, onOpen } = props
  if (!canChange && !card.after.length) return null
  const open = new Set(unmetPrerequisites([card], cards, doneList)[0]?.needs ?? [])
  const waited = card.after.map(id => ({ id, card: cards.find(c => c.id === id) }))
  // Never one already waited on, nor one waiting on this card: that order would loop.
  const pickable = cards
    .filter(c => c.id !== card.id && !c.archived && !isDivider(c) && !card.after.includes(c.id))
    .filter(c => !findCycle(cards.map(x => (x.id === card.id ? { id: x.id, after: [...card.after, c.id] } : x))))
    .sort((a, b) => cardNumber(b.id) - cardNumber(a.id))
  return (
    <section>
      <h3>Do after</h3>
      {waited.length > 0 && (
        <ul className="detail-rows">
          {waited.map(({ id, card: before }) => {
            const state = !before ? 'not on this board' : before.archived ? 'archived' : open.has(id) ? undefined : 'done'
            return (
              <li key={id} className={state === 'done' ? 'done' : undefined}>
                <button type="button" className="detail-row" disabled={!before} onClick={() => before && onOpen({ id, card: before })}>
                  <span className="card-id">{id}</span>
                  <span className="detail-title">
                    {before?.title}
                    {state && <span className="detail-note">{before ? ` · ${state}` : state}</span>}
                  </span>
                </button>
                {canChange && (
                  <button type="button" className="remove" aria-label={`Not after ${id}`} disabled={busy} onClick={() => onChange({ after: { remove: [id] } })}>
                    ×
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {canChange && (
        <select
          className="after-pick"
          aria-label="Do it after another card"
          disabled={busy || !pickable.length}
          value=""
          onChange={e => e.target.value && onChange({ after: { add: [e.target.value] } })}
        >
          <option value="">{pickable.length ? 'Do it after…' : 'No other card to wait on'}</option>
          {pickable.map(c => (
            <option key={c.id} value={c.id}>
              {c.id} · {c.title}
            </option>
          ))}
        </select>
      )}
    </section>
  )
}
