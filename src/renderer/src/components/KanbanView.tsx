import {
  closestCorners,
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { memo, useMemo, useState } from 'react'
import { between, isDivider } from '@shared/cardfile'
import type { Card, CodeCommit, LoadedBoard } from '@shared/types'
import { tackleCards } from '../tackle'
import { actions, api, commitsFor, listColor, useStore, NONE } from '../state'
import { TackleMenu } from './TackleMenu'

/** The column of cards with no list: ideas that only live on the map. Dropping a card here unlists it. */
const UNLISTED = '__unlisted__'
const COLUMN_LIMIT = 60

type Columns = Record<string, string[]>

export function KanbanView({ board, matches }: { board: LoadedBoard; matches: (c: Card) => boolean }) {
  const commits = useStore(s => s.commits[board.path])
  const selected = useStore(s => s.selected[board.path] ?? NONE)
  const [draft, setDraft] = useState<Columns | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const byId = useMemo(() => new Map(board.cards.map(c => [c.id, c])), [board.cards])
  const columns = useMemo(() => {
    const cols: Columns = { [UNLISTED]: [] }
    for (const list of board.meta.lists) cols[list.id] = []
    for (const card of board.cards) {
      if (card.archived || !matches(card)) continue
      const key = card.list === null ? UNLISTED : card.list
      if (cols[key]) cols[key].push(card.id)
    }
    return cols
  }, [board, matches])
  const shown = draft ?? columns

  const containerOf = (cols: Columns, id: string): string | undefined => {
    if (id.startsWith('list:')) return id.slice(5)
    return Object.keys(cols).find(key => cols[key].includes(id))
  }

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id))
    setDraft(structuredClone(columns))
  }

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || !draft) return
    const from = containerOf(draft, String(active.id))
    const to = containerOf(draft, String(over.id))
    if (!from || !to || from === to) return
    setDraft(cols => {
      if (!cols) return cols
      const next = { ...cols, [from]: cols[from].filter(id => id !== active.id), [to]: [...cols[to]] }
      const overIndex = next[to].indexOf(String(over.id))
      next[to].splice(overIndex < 0 ? next[to].length : overIndex, 0, String(active.id))
      return next
    })
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const cols = draft
    setActiveId(null)
    setDraft(null)
    if (!cols || !over) return
    const id = String(active.id)
    const to = containerOf(cols, id)
    if (!to) return
    let list = cols[to]
    const overId = String(over.id)
    if (!overId.startsWith('list:') && list.includes(overId) && overId !== id) {
      list = arrayMove(list, list.indexOf(id), list.indexOf(overId))
    }
    const index = list.indexOf(id)
    const card = byId.get(id)
    if (!card) return
    const prev = index > 0 ? byId.get(list[index - 1])?.pos : undefined
    const next = index < list.length - 1 ? byId.get(list[index + 1])?.pos : undefined
    const targetList = to === UNLISTED ? null : to
    const sameSpot =
      card.list === targetList &&
      columns[to]?.indexOf(id) === index
    if (sameSpot) return
    void actions.updateCard(board.path, id, { list: targetList, pos: between(prev, next) })
  }

  const lists = [
    ...(shown[UNLISTED].length || activeId ? [{ id: UNLISTED, title: 'Map only (ideas)' }] : []),
    ...board.meta.lists,
  ]

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => (setActiveId(null), setDraft(null))}
    >
      <div className="kanban">
        {lists.map(list => {
          const ids = shown[list.id] ?? []
          const limited = ids.length > COLUMN_LIMIT && !expanded.has(list.id) && !activeId
          const visible = limited ? ids.slice(0, COLUMN_LIMIT) : ids
          return (
            <Column
              key={list.id}
              board={board}
              listId={list.id}
              title={list.title}
              ids={ids}
              color={listColor(board, list.id === UNLISTED ? null : list.id)}
            >
              <SortableContext items={visible} strategy={verticalListSortingStrategy}>
                {visible.map(id => {
                  const card = byId.get(id)
                  return card ? (
                    <SortableCard
                      key={id}
                      board={board}
                      card={card}
                      commits={commits}
                      selected={selected.includes(id)}
                    />
                  ) : null
                })}
              </SortableContext>
              {limited && (
                <button className="show-more" onClick={() => setExpanded(s => new Set(s).add(list.id))}>
                  Show all {ids.length}
                </button>
              )}
            </Column>
          )
        })}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeId && byId.get(activeId) ? (
          <CardFace board={board} card={byId.get(activeId)!} commits={commits} selected={false} dragging />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function Column({
  board,
  listId,
  title,
  ids,
  color,
  children,
}: {
  board: LoadedBoard
  listId: string
  title: string
  ids: string[]
  color: string
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `list:${listId}` })
  const [adding, setAdding] = useState(false)
  const work = ids.filter(id => {
    const card = board.cards.find(c => c.id === id)
    return card && !isDivider(card)
  })

  return (
    <div className={`column${isOver ? ' over' : ''}`} data-list={listId}>
      <div className="column-head" style={{ borderTopColor: color }}>
        <span className="column-title">{title}</span>
        <span className="column-count">{work.length}</span>
        {work.length > 0 && (
          <TackleMenu
            label="Tackle all"
            many={work.length > 1}
            compact
            onPick={(mode, split) =>
              void tackleCards(board.path, work, mode, { split, listTitle: title })
            }
          />
        )}
      </div>
      <div className="column-body" ref={setNodeRef}>
        {children}
        {adding ? (
          <AddCard board={board} listId={listId} onDone={() => setAdding(false)} />
        ) : (
          <button className="add-card" onClick={() => setAdding(true)}>
            + Add a card
          </button>
        )}
      </div>
    </div>
  )
}

function AddCard({ board, listId, onDone }: { board: LoadedBoard; listId: string; onDone: () => void }) {
  const [title, setTitle] = useState('')
  const submit = async () => {
    const text = title.trim()
    if (!text) return onDone()
    setTitle('')
    try {
      await api.cards.create(board.path, { title: text, list: listId === UNLISTED ? null : listId })
    } catch (error) {
      actions.toast((error as Error).message, 'error')
    }
  }
  return (
    <div className="add-card-form">
      <textarea
        autoFocus
        rows={2}
        placeholder="Card title (Enter to add, Esc to stop)"
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            onDone()
          }
        }}
        onBlur={() => (title.trim() ? void submit().then(onDone) : onDone())}
      />
    </div>
  )
}

const SortableCard = memo(function SortableCard(props: {
  board: LoadedBoard
  card: Card
  commits: CodeCommit[] | undefined
  selected: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.card.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
      {...attributes}
      {...listeners}
    >
      <CardFace {...props} />
    </div>
  )
})

export function CardFace({
  board,
  card,
  commits,
  selected,
  dragging,
}: {
  board: LoadedBoard
  card: Card
  commits: CodeCommit[] | undefined
  selected: boolean
  dragging?: boolean
}) {
  const open = useStore(s => s.openCard?.boardPath === board.path && s.openCard.id === card.id)
  if (isDivider(card)) {
    return (
      <div className="divider-card" title={`${card.id} (divider)`} onClick={() => actions.openCard(board.path, card.id)}>
        <span />
      </div>
    )
  }
  const linked = commitsFor(commits, card.id).length
  const running = card.sessions.length
  return (
    <div
      className={`card${selected ? ' selected' : ''}${open ? ' open' : ''}${dragging ? ' dragging' : ''}${card.complete ? ' complete' : ''}`}
      data-card={card.id}
      onClick={e => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) actions.toggleSelected(board.path, card.id)
        else actions.openCard(board.path, card.id)
      }}
    >
      <div className="card-title">{card.title}</div>
      <div className="card-meta">
        <span className="card-id">{card.id}</span>
        {card.complete && <span className="badge ok" title="Marked complete">✓</span>}
        {card.body.trim() && <span className="badge" title="Has a description">≡</span>}
        {card.links.length > 0 && <span className="badge" title="Linked cards">⛓ {card.links.length}</span>}
        {linked > 0 && <span className="badge commit" title="Commits naming this card">⎇ {linked}</span>}
        {running > 0 && <span className="badge session" title="Claude sessions started for it">▶ {running}</span>}
        {card.due && <span className="badge" title="Due">⏰ {card.due.slice(0, 10)}</span>}
      </div>
    </div>
  )
}
