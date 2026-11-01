// A board: its lists as tabs along the top (they read better on a phone than columns scrolled
// sideways), the open list's cards in the desktop's order, the cards waiting to be sent at its end,
// and the "+" for a new one. An *Archived* tab at the end holds the archived cards, and the
// magnifier beside the tabs finds cards over the whole board, archived ones last. The ⋯ beside it,
// or a long press on a tab, opens that list's menu (ListMenu.tsx), and the board's settings.

import { useMemo, useState } from 'react'
import { isDivider, listColorAt } from '@shared/cardfile'
import { boardColumns, UNLISTED } from '@shared/selection'
import type { BoardMeta, Card, ListDef } from '@shared/types'
import type { BoardChange } from '../repo/boardchange'
import { archivedCards, findCards, whereCard } from '../repo/find'
import type { Board } from '../repo/reader'
import type { Draft } from '../repo/writer'
import type { RepoState } from './Browse'
import { FindBar, FindButton } from './Find'
import { ListMenu } from './ListMenu'
import { count, formatDue, Header, Pull } from './parts'

/** The tab of the board's archived cards. */
export const ARCHIVED = '__archived__'

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
  /** Signed in, with the board read: its board.json can be changed. */
  canChangeBoard: boolean
  /** Writes a change to board.json; answers the meta as written, or nothing when it failed. */
  onBoardChange: (change: BoardChange) => Promise<BoardMeta | undefined>
  /** Why the last change to board.json failed. */
  boardError?: string
  onSettings: () => void
}) {
  const { title, state, board, loading, onBack, onList, onCard, onRefresh, drafts, offline, onAdd, onDiscard } = props
  /** The search's text, while the field is open. */
  const [query, setQuery] = useState<string>()
  /** The tab whose menu is open. */
  const [menu, setMenu] = useState<string>()
  const columns = useMemo(() => (board ? boardColumns(board, () => true) : undefined), [board])
  const byId = useMemo(() => new Map(board?.cards.map(c => [c.id, c])), [board])
  const lists: (ListDef & { color: string })[] = board
    ? board.meta.lists.flatMap((l, i) => (l.archived ? [] : [{ ...l, color: listColorAt(board.meta.lists, i) }]))
    : []
  if (columns?.[UNLISTED].length) lists.unshift({ id: UNLISTED, title: 'Ideas', color: 'var(--idea)' })
  const archived = useMemo(() => (board ? archivedCards(board) : []), [board])
  if (archived.length) lists.push({ id: ARCHIVED, title: 'Archived', color: 'var(--muted)' })
  const current = lists.find(l => l.id === props.list) ?? lists[0]
  const found = useMemo(() => (board && query?.trim() ? findCards(board, query) : undefined), [board, query])
  const listed = (current && columns?.[current.id]?.map(id => byId.get(id)).filter((c): c is Card => !!c)) ?? []
  const cards = found ?? (current?.id === ARCHIVED ? archived : listed)
  // Results and the archive come from every list: each says where it is.
  const where = board && (found || current?.id === ARCHIVED) ? (card: Card) => whereCard(board, card) : undefined
  const waiting = found ? [] : drafts.filter(d => (d.list ?? UNLISTED) === current?.id)
  const sub = found ? `${found.length} found` : current ? count(cards.filter(c => !isDivider(c)).length) : undefined

  return (
    <>
      <Header title={title} sub={sub} onBack={onBack} busy={state.busy || loading} />
      {query !== undefined ? (
        <FindBar query={query} onQuery={setQuery} onClose={() => setQuery(undefined)} />
      ) : (
        <div className="tabbar">
          <nav className="tabs">
            {lists.map(l => (
              <button
                key={l.id}
                type="button"
                className={l.id === current?.id ? 'tab active' : 'tab'}
                style={{ borderBottomColor: l.id === current?.id ? l.color : 'transparent' }}
                onClick={() => onList(l.id)}
                onContextMenu={e => {
                  // A long press on a phone.
                  e.preventDefault()
                  if (board) setMenu(l.id)
                }}
              >
                <span className="dot" style={{ background: l.color }} />
                {l.title}
              </button>
            ))}
          </nav>
          {board && <FindButton onOpen={() => setQuery('')} />}
          {board && (
            <button type="button" className="tabbar-button" aria-label="List menu" onClick={() => setMenu(current?.id ?? '')}>
              ⋯
            </button>
          )}
        </div>
      )}
      <Pull onRefresh={onRefresh}>
        {state.error && <p className="note error">{state.error}</p>}
        {props.boardError && <p className="note error">{props.boardError}</p>}
        {!board && <p className="note">{loading ? 'Reading the cards…' : 'This board isn’t saved on the phone yet.'}</p>}
        {!!board?.missing && <p className="note">{board.missing} cards aren’t saved on the phone yet.</p>}
        {board && (current || found) && !cards.length && !waiting.length && <p className="note">{found ? 'No card matches.' : 'No cards.'}</p>}
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
                    {where && <span className="chip where">{where(card)}</span>}
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
      {board && menu !== undefined && (
        <ListMenu
          meta={board.meta}
          list={board.meta.lists.find(l => l.id === menu && !l.archived)}
          count={columns?.[menu]?.filter(id => !isDivider(byId.get(id) ?? { title: '' })).length}
          canChange={props.canChangeBoard}
          onClose={() => setMenu(undefined)}
          onSettings={props.onSettings}
          onChange={async change => {
            const meta = await props.onBoardChange(change)
            // A new list opens, to put cards in.
            if (meta && change.kind === 'addList') onList(meta.lists.at(-1)!.id)
          }}
        />
      )}
      {current && current.id !== ARCHIVED && !found && (
        <button className="fab" type="button" aria-label={`New card in ${current.title}`} onClick={onAdd}>
          +
        </button>
      )}
    </>
  )
}
