// A board: its lists as tabs along the top (they read better on a phone than columns scrolled
// sideways), the open list's cards in the desktop's order, the cards waiting to be sent at its end,
// and the "+" for a new one.

import { useMemo } from 'react'
import { isDivider, listColorAt } from '@shared/cardfile'
import { boardColumns, UNLISTED } from '@shared/selection'
import type { Card, ListDef } from '@shared/types'
import type { Board } from '../repo/reader'
import type { Draft } from '../repo/writer'
import type { RepoState } from './Browse'
import { count, formatDue, Header, Pull } from './parts'

export function BoardView(props: {
  title: string
  state: RepoState
  board?: Board
  loading: boolean
  list?: string
  onBack: () => void
  onList: (list: string) => void
  onCard: (id: string) => void
  onRefresh: () => Promise<void>
  /** Cards written here and not yet sent, of this board. */
  drafts: Draft[]
  offline: boolean
  onAdd: () => void
  onDiscard: (key: string) => void
}) {
  const { title, state, board, loading, onBack, onList, onCard, onRefresh, drafts, offline, onAdd, onDiscard } = props
  const columns = useMemo(() => (board ? boardColumns(board, () => true) : undefined), [board])
  const byId = useMemo(() => new Map(board?.cards.map(c => [c.id, c])), [board])
  const lists: (ListDef & { color: string })[] = board
    ? board.meta.lists.flatMap((l, i) => (l.archived ? [] : [{ ...l, color: listColorAt(board.meta.lists, i) }]))
    : []
  if (columns?.[UNLISTED].length) lists.unshift({ id: UNLISTED, title: 'Ideas', color: 'var(--idea)' })
  const current = lists.find(l => l.id === props.list) ?? lists[0]
  const cards = (current && columns?.[current.id]?.map(id => byId.get(id)).filter((c): c is Card => !!c)) ?? []
  const waiting = drafts.filter(d => (d.list ?? UNLISTED) === current?.id)

  return (
    <>
      <Header title={title} sub={current ? count(cards.filter(c => !isDivider(c)).length) : undefined} onBack={onBack} busy={state.busy || loading} />
      <nav className="tabs">
        {lists.map(l => (
          <button
            key={l.id}
            type="button"
            className={l.id === current?.id ? 'tab active' : 'tab'}
            style={{ borderBottomColor: l.id === current?.id ? l.color : 'transparent' }}
            onClick={() => onList(l.id)}
          >
            <span className="dot" style={{ background: l.color }} />
            {l.title}
          </button>
        ))}
      </nav>
      <Pull onRefresh={onRefresh}>
        {state.error && <p className="note error">{state.error}</p>}
        {!board && <p className="note">{loading ? 'Reading the cards…' : 'This board isn’t saved on the phone yet.'}</p>}
        {!!board?.missing && <p className="note">{board.missing} cards aren’t saved on the phone yet.</p>}
        {board && current && !cards.length && !waiting.length && <p className="note">No cards.</p>}
        <ul className="cards">
          {cards.map(card =>
            isDivider(card) ? (
              <li key={card.id} className="divider" />
            ) : (
              <li key={card.id}>
                <button type="button" className="card" onClick={() => onCard(card.id)}>
                  <span className="card-title">{card.title}</span>
                  <span className="card-meta">
                    <span className="card-id">{card.id}</span>
                    {card.complete && <span className="chip done">Done</span>}
                    {card.due && <span className="chip">{formatDue(card.due)}</span>}
                    {card.labels.map(l => (
                      <span key={l} className="chip">
                        {l}
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            ),
          )}
          {waiting.map(draft => (
            <li key={draft.key}>
              <div className="card pending">
                <span className="card-title">{draft.title}</span>
                <span className="card-meta">
                  <span className="chip">{draft.error ? 'Not sent' : offline ? 'Waiting to sign in' : 'Waiting to send'}</span>
                  <button type="button" className="link" onClick={() => onDiscard(draft.key)}>
                    Discard
                  </button>
                </span>
                {draft.error && <span className="pending-error">{draft.error}</span>}
              </div>
            </li>
          ))}
        </ul>
      </Pull>
      {current && (
        <button className="fab" type="button" aria-label={`New card in ${current.title}`} onClick={onAdd}>
          +
        </button>
      )}
    </>
  )
}
