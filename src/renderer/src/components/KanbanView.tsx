import {
  closestCenter,
  closestCorners,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { between, freezeListColors, isDivider, reorderLists, slugify } from '@shared/cardfile'
import type { Card, CodeCommit, ListDef, LoadedBoard } from '@shared/types'
import { useGrabScroll } from '../grabScroll'
import { cardMenu, listMenu } from '../menus'
import { actions, api, commitsFor, listColor, NONE, useStore } from '../state'
import { openContextMenu } from './ContextMenu'

/** The column of cards with no list: ideas that only live on the map. Shown when it has any. */
const UNLISTED = '__unlisted__'
const COLUMN_LIMIT = 60
/** Drop zones in the tray that slides up while a card is dragged. */
const ZONE_UNLIST = 'zone:unlist'
const ZONE_ARCHIVE = 'zone:archive'
/** A list is dragged by its header; its sortable id is `col:<list id>`. */
const COL = 'col:'

type Columns = Record<string, string[]>

/**
 * A dragged list only meets other lists. A dragged card meets the tray's zones when the pointer
 * is inside one, otherwise the nearest card or list body.
 */
const collision: CollisionDetection = args => {
  const isZone = (id: unknown) => String(id).startsWith('zone:')
  const isColumn = (id: unknown) => String(id).startsWith(COL)
  if (isColumn(args.active.id)) {
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(c => isColumn(c.id)) })
  }
  const zones = pointerWithin({ ...args, droppableContainers: args.droppableContainers.filter(c => isZone(c.id)) })
  if (zones.length) return zones
  return closestCorners({
    ...args,
    droppableContainers: args.droppableContainers.filter(c => !isZone(c.id) && !isColumn(c.id)),
  })
}

export function KanbanView({ board, matches }: { board: LoadedBoard; matches: (c: Card) => boolean }) {
  const commits = useStore(s => s.commits[board.path])
  const selected = useStore(s => s.selected[board.path] ?? NONE)
  const collapsed = useStore(s => s.collapsed[board.path] ?? NONE)
  const [draft, setDraft] = useState<Columns | null>(null)
  /** The card being dragged. */
  const [activeId, setActiveId] = useState<string | null>(null)
  /** The list being dragged by its header. */
  const [activeColumn, setActiveColumn] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const grab = useGrabScroll(scroller)
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
    const id = String(e.active.id)
    if (id.startsWith(COL)) {
      setActiveColumn(id.slice(COL.length))
      return
    }
    setActiveId(id)
    setDraft(structuredClone(columns))
  }

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || !draft || String(over.id).startsWith('zone:') || String(active.id).startsWith(COL)) return
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
    if (String(active.id).startsWith(COL)) {
      setActiveColumn(null)
      if (over && String(over.id).startsWith(COL)) reorderList(String(active.id).slice(COL.length), String(over.id).slice(COL.length))
      return
    }
    const cols = draft
    setActiveId(null)
    setDraft(null)
    if (!cols || !over) return
    const id = String(active.id)
    const card = byId.get(id)
    if (!card) return
    if (over.id === ZONE_UNLIST) {
      if (card.list !== null) void actions.updateCard(board.path, id, { list: null })
      return
    }
    if (over.id === ZONE_ARCHIVE) {
      void actions.updateCard(board.path, id, { archived: true })
      actions.toast(`Archived ${id}`)
      return
    }
    const to = containerOf(cols, id)
    if (!to) return
    let list = cols[to]
    const overId = String(over.id)
    if (!overId.startsWith('list:') && list.includes(overId) && overId !== id) {
      list = arrayMove(list, list.indexOf(id), list.indexOf(overId))
    }
    const index = list.indexOf(id)
    const prev = index > 0 ? byId.get(list[index - 1])?.pos : undefined
    const next = index < list.length - 1 ? byId.get(list[index + 1])?.pos : undefined
    const targetList = to === UNLISTED ? null : to
    if (card.list === targetList && columns[to]?.indexOf(id) === index) return
    void actions.updateCard(board.path, id, { list: targetList, pos: between(prev, next) })
  }

  /** Moves a list to where another one stood (archived lists keep their places in board.json). */
  const reorderList = (from: string, to: string) => {
    const lists = reorderLists(board.meta.lists, from, to)
    if (lists) void actions.setLists(board.path, lists)
  }

  // Ideas get a column only when there are some: it must never appear mid-drag and shift the board.
  const lists: (ListDef & { unlisted?: boolean })[] = [
    ...(columns[UNLISTED].length ? [{ id: UNLISTED, title: 'Map only (ideas)', unlisted: true }] : []),
    ...board.meta.lists.filter(l => !l.archived),
  ]
  const columnIds = lists.filter(l => !l.unlisted).map(l => `${COL}${l.id}`)
  const draggedList = activeColumn ? lists.find(l => l.id === activeColumn) : undefined

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      // dnd-kit focuses the dragged card again a moment after a drop, which blurred (and so
      // closed) an add-card field opened right after a drag.
      accessibility={{ restoreFocus: false }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => (setActiveId(null), setActiveColumn(null), setDraft(null))}
    >
      <div className="kanban-wrap">
        <div className={`kanban${grab.grabbing ? ' grabbing' : ''}`} ref={scroller} {...grab.handlers}>
          <SortableContext items={columnIds} strategy={horizontalListSortingStrategy}>
          {lists.map(list => {
            const ids = shown[list.id] ?? []
            if (collapsed.includes(list.id) && !activeId) {
              return (
                <CollapsedColumn
                  key={list.id}
                  board={board}
                  list={list}
                  count={ids.length}
                  color={listColor(board, list.unlisted ? null : list.id)}
                />
              )
            }
            const limited = ids.length > COLUMN_LIMIT && !expanded.has(list.id) && !activeId
            const visible = limited ? ids.slice(0, COLUMN_LIMIT) : ids
            const ColumnKind = list.unlisted ? Column : SortableColumn
            return (
              <ColumnKind
                key={list.id}
                board={board}
                list={list}
                ids={ids}
                color={listColor(board, list.unlisted ? null : list.id)}
                adding={adding === list.id}
                setAdding={on => setAdding(on ? list.id : null)}
                renaming={renaming === list.id}
                setRenaming={on => setRenaming(on ? list.id : null)}
              >
                <SortableContext items={visible} strategy={verticalListSortingStrategy}>
                  {visible.map(id => {
                    const card = byId.get(id)
                    return card ? (
                      <SortableCard key={id} board={board} card={card} commits={commits} selected={selected.includes(id)} />
                    ) : null
                  })}
                </SortableContext>
                {limited && (
                  <button className="show-more" onClick={() => setExpanded(s => new Set(s).add(list.id))}>
                    Show all {ids.length}
                  </button>
                )}
              </ColumnKind>
            )
          })}
          </SortableContext>
          <AddListColumn board={board} />
        </div>
        <DragTray active={!!activeId} />
      </div>
      <DragOverlay dropAnimation={null}>
        {activeId && byId.get(activeId) ? (
          <CardFace board={board} card={byId.get(activeId)!} commits={commits} selected={false} dragging />
        ) : draggedList ? (
          <ColumnPreview
            title={draggedList.title}
            color={listColor(board, draggedList.id)}
            cards={(columns[draggedList.id] ?? []).map(id => byId.get(id)).filter((c): c is Card => !!c)}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

/** Slides up from the bottom while a card is dragged: drop targets that are not lists. */
function DragTray({ active }: { active: boolean }) {
  return (
    <div className={`drag-tray${active ? ' up' : ''}`} aria-hidden={!active}>
      <TrayZone id={ZONE_UNLIST} label="Map only (idea)" hint="Takes it off the board, keeps it on the map" icon="◇" />
      <TrayZone id={ZONE_ARCHIVE} label="Archive" hint="Hides it; the table view still lists it" icon="▣" danger />
    </div>
  )
}

function TrayZone({ id, label, hint, icon, danger }: { id: string; label: string; hint: string; icon: string; danger?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div ref={setNodeRef} className={`tray-zone${isOver ? ' over' : ''}${danger ? ' danger' : ''}`} data-zone={id}>
      <span className="tray-icon">{icon}</span>
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
    </div>
  )
}

type ColumnProps = {
  board: LoadedBoard
  list: ListDef & { unlisted?: boolean }
  ids: string[]
  color: string
  adding: boolean
  setAdding: (on: boolean) => void
  renaming: boolean
  setRenaming: (on: boolean) => void
  children: React.ReactNode
}

type DragHandle = {
  setNodeRef: (node: HTMLElement | null) => void
  setActivatorNodeRef: (node: HTMLElement | null) => void
  listeners: ReturnType<typeof useSortable>['listeners']
  attributes: ReturnType<typeof useSortable>['attributes']
  style: React.CSSProperties
  isDragging: boolean
}

/** A list column that moves when its header is dragged (not while its title is being edited). */
function SortableColumn(props: ColumnProps) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({
    id: `${COL}${props.list.id}`,
    disabled: props.renaming,
  })
  const drag: DragHandle = {
    setNodeRef,
    setActivatorNodeRef,
    listeners,
    attributes,
    style: { transform: CSS.Translate.toString(transform), transition },
    isDragging,
  }
  return <Column {...props} drag={drag} />
}

function Column({
  board,
  list,
  ids,
  color,
  adding,
  setAdding,
  renaming,
  setRenaming,
  children,
  drag,
}: ColumnProps & { drag?: DragHandle }) {
  const { setNodeRef, isOver } = useDroppable({ id: `list:${list.id}` })
  const work = ids.filter(id => {
    const card = board.cards.find(c => c.id === id)
    return card && !isDivider(card)
  })
  const menu = (e: React.MouseEvent) => {
    if (list.unlisted) return
    openContextMenu(e, listMenu(board, list, { addCard: () => setAdding(true), rename: () => setRenaming(true) }))
  }

  return (
    <div
      ref={drag?.setNodeRef}
      style={drag?.style}
      className={`column${isOver ? ' over' : ''}${drag?.isDragging ? ' lifted' : ''}`}
      data-list={list.id}
    >
      <div
        ref={drag?.setActivatorNodeRef}
        {...drag?.attributes}
        {...drag?.listeners}
        className={`column-head${drag ? ' draggable' : ''}`}
        style={{ borderTopColor: color }}
        title={drag && !renaming ? 'Drag to move the list; double-click the title to rename it' : undefined}
        onContextMenu={menu}
        onDoubleClick={e => {
          if (!list.unlisted && (e.target as HTMLElement).closest('.column-title')) setRenaming(true)
        }}
      >
        {renaming ? (
          <RenameList board={board} list={list} onDone={() => setRenaming(false)} />
        ) : (
          <span className="column-title" title={list.title}>
            {list.title}
          </span>
        )}
        <span className="column-count">{work.length}</span>
        {!list.unlisted && (
          <button className="icon-button small column-menu" aria-label={`${list.title} actions`} onClick={menu}>
            ⋯
          </button>
        )}
      </div>
      <div className="column-body" ref={setNodeRef}>
        {children}
        {adding ? (
          <AddCard board={board} listId={list.id} onDone={() => setAdding(false)} />
        ) : (
          <button className="add-card" onClick={() => setAdding(true)}>
            + Add a card
          </button>
        )}
      </div>
    </div>
  )
}

function CollapsedColumn({ board, list, count, color }: { board: LoadedBoard; list: ListDef; count: number; color: string }) {
  const { setNodeRef: setDropRef } = useDroppable({ id: `list:${list.id}` })
  const { setNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({ id: `${COL}${list.id}` })
  return (
    <button
      ref={node => {
        setDropRef(node)
        setNodeRef(node)
      }}
      {...attributes}
      {...listeners}
      className={`column collapsed${isDragging ? ' lifted' : ''}`}
      style={{ borderTopColor: color, transform: CSS.Translate.toString(transform), transition }}
      data-list={list.id}
      title={`Expand “${list.title}”`}
      onClick={() => actions.toggleCollapsed(board.path, list.id)}
      onContextMenu={e => openContextMenu(e, listMenu(board, list, { addCard: () => {}, rename: () => {} }))}
    >
      <span className="collapsed-count">{count}</span>
      <span className="collapsed-title">{list.title}</span>
    </button>
  )
}

/** What follows the pointer while a list is dragged: its header and its first cards. */
function ColumnPreview({ title, color, cards }: { title: string; color: string; cards: Card[] }) {
  const work = cards.filter(c => !isDivider(c))
  return (
    <div className="column column-preview">
      <div className="column-head" style={{ borderTopColor: color }}>
        <span className="column-title">{title}</span>
        <span className="column-count">{work.length}</span>
      </div>
      <div className="column-body">
        {work.slice(0, 4).map(card => (
          <div key={card.id} className="card">
            <div className="card-title">{card.title}</div>
          </div>
        ))}
        {work.length > 4 && <div className="muted small preview-more">+ {work.length - 4} more</div>}
      </div>
    </div>
  )
}

function RenameList({ board, list, onDone }: { board: LoadedBoard; list: ListDef; onDone: () => void }) {
  const [title, setTitle] = useState(list.title)
  const save = () => {
    const text = title.trim()
    onDone()
    if (!text || text === list.title) return
    void api.boards
      .updateMeta(board.path, { lists: board.meta.lists.map(l => (l.id === list.id ? { ...l, title: text } : l)) })
      .then(() => actions.loadBoard(board.path))
  }
  return (
    <input
      className="rename-list"
      autoFocus
      value={title}
      onFocus={e => e.target.select()}
      onChange={e => setTitle(e.target.value)}
      onBlur={save}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        else if (e.key === 'Escape') {
          e.stopPropagation()
          setTitle(list.title)
          onDone()
        }
      }}
    />
  )
}

function AddListColumn({ board }: { board: LoadedBoard }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ behavior: 'smooth', inline: 'end', block: 'nearest' })
  }, [open])

  const add = async () => {
    const text = title.trim()
    if (!text) return setOpen(false)
    const base = slugify(text)
    let id = base
    for (let n = 2; board.meta.lists.some(l => l.id === id); n++) id = `${base}-${n}`
    setTitle('')
    // Its colour is written down with it, so later moves never change it.
    const lists = freezeListColors([...board.meta.lists, { id, title: text }])
    await api.boards.updateMeta(board.path, { lists })
    await actions.loadBoard(board.path)
  }

  return (
    <div className="column add-list" ref={ref}>
      {open ? (
        <div className="add-list-form">
          <input
            autoFocus
            placeholder="List title (Enter to add)"
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void add()
              else if (e.key === 'Escape') {
                e.stopPropagation()
                setOpen(false)
              }
            }}
            onBlur={() => (title.trim() ? void add().then(() => setOpen(false)) : setOpen(false))}
          />
        </div>
      ) : (
        <button className="add-list-button" onClick={() => setOpen(true)}>
          + Add a list
        </button>
      )}
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
  const menu = (e: React.MouseEvent) => openContextMenu(e, cardMenu(board, card))
  if (isDivider(card)) {
    return (
      <div
        className="divider-card"
        title={`${card.id} (divider)`}
        onClick={() => actions.openCard(board.path, card.id)}
        onContextMenu={menu}
      >
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
      onContextMenu={menu}
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
