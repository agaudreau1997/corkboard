import {
  applyNodeChanges,
  Background,
  BaseEdge,
  ConnectionMode,
  Controls,
  getStraightPath,
  Handle,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useInternalNode,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type FinalConnectionState,
  type InternalNode,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isDivider } from '@shared/cardfile'
import {
  AREA_MIN_H,
  AREA_MIN_W,
  areaAt,
  estimateHeight,
  fitArea,
  layoutArea,
  NODE_W,
  resolveLayout,
} from '@shared/maplayout'
import type { BoardMap, Card, LoadedBoard, MapArea, MapNodePos } from '@shared/types'
import { cardMenu } from '../menus'
import { actions, api, listColor, NONE, useStore } from '../state'
import { openContextMenu, type MenuItem } from './ContextMenu'

type CardNodeData = { card: Card; color: string; listTitle: string; selectedForTackle: boolean }
type AreaNodeData = {
  listId: string
  title: string
  color: string
  count: number
  over: boolean
  onMenu: (e: React.MouseEvent) => void
  onResizeEnd: (area: MapArea) => void
}
type CardNode = Node<CardNodeData, 'card'>
type AreaNode = Node<AreaNodeData, 'area'>
type MapNode = CardNode | AreaNode

/** A card being written on the map: where its input sits, and what it joins and links. */
type Draft = { screen: { x: number; y: number }; at: MapNodePos; list: string | null; linkFrom?: string }

const AREA = 'area:'

export function MapView(props: { board: LoadedBoard; matches: (c: Card) => boolean }) {
  return (
    <ReactFlowProvider>
      <MapCanvas {...props} />
    </ReactFlowProvider>
  )
}

function MapCanvas({ board, matches }: { board: LoadedBoard; matches: (c: Card) => boolean }) {
  const selected = useStore(s => s.selected[board.path] ?? NONE)
  const flow = useReactFlow<MapNode, Edge>()
  const container = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [overArea, setOverArea] = useState<string | null>(null)
  const dragStart = useRef<{ area: MapNodePos; members: Map<string, MapNodePos> } | null>(null)

  const hidden = useMemo(() => new Set(board.map.hiddenLists ?? []), [board.map.hiddenLists])
  const showUnlisted = board.map.showUnlisted !== false
  const shownLists = useMemo(
    () => board.meta.lists.filter(l => !l.archived && !hidden.has(l.id)),
    [board.meta.lists, hidden],
  )
  const visible = useMemo(
    () =>
      board.cards.filter(
        c =>
          !c.archived &&
          !isDivider(c) &&
          matches(c) &&
          (c.list === null ? showUnlisted : shownLists.some(l => l.id === c.list)),
      ),
    [board.cards, matches, showUnlisted, shownLists],
  )
  const layout = useMemo(() => resolveLayout(board.map, shownLists, visible), [board.map, shownLists, visible])

  const saveMap = useCallback(
    (map: BoardMap) => {
      actions.setMapLocal(board.path, map)
      void api.map.save(board.path, map)
    },
    [board.path],
  )

  /** What is on screen now: the areas and card positions as the nodes hold them. */
  const current = (ns: MapNode[]) => {
    const areas: Record<string, MapArea> = {}
    const nodes: Record<string, MapNodePos> = {}
    for (const n of ns) {
      if (n.type === 'area') {
        areas[n.data.listId] = { x: n.position.x, y: n.position.y, w: n.width ?? AREA_MIN_W, h: n.height ?? AREA_MIN_H }
      } else nodes[n.id] = { x: n.position.x, y: n.position.y }
    }
    return { areas, nodes }
  }

  /** Writes every backdrop and card where it stands (so nothing re-lays out around a change). */
  const pinAll = (ns: MapNode[], patch: { areas?: Record<string, MapArea>; nodes?: Record<string, MapNodePos> } = {}) => {
    const now = current(ns)
    saveMap({
      ...board.map,
      areas: { ...board.map.areas, ...now.areas, ...patch.areas },
      nodes: { ...board.map.nodes, ...now.nodes, ...patch.nodes },
    })
  }

  const relayoutAll = () => {
    const fresh = resolveLayout({ nodes: {} }, shownLists, visible)
    saveMap({ ...board.map, areas: { ...board.map.areas, ...fresh.areas }, nodes: { ...board.map.nodes, ...fresh.nodes } })
  }

  const startDraft = (at: MapNodePos, list: string | null, linkFrom?: string, screen?: { x: number; y: number }) => {
    const box = container.current?.getBoundingClientRect()
    const s = screen ?? flow.flowToScreenPosition(at)
    setDraft({ at, list, linkFrom, screen: { x: s.x - (box?.left ?? 0), y: s.y - (box?.top ?? 0) } })
  }

  const areaMenu = (listId: string, ns: MapNode[]): MenuItem[] => {
    const list = board.meta.lists.find(l => l.id === listId)
    const inList = visible.filter(c => c.list === listId)
    return [
      { heading: `${list?.title ?? listId} · ${inList.length} card${inList.length === 1 ? '' : 's'}` },
      {
        label: 'Automatically lay out',
        hint: 'in its backdrop',
        onSelect: () => {
          const area = current(ns).areas[listId]
          if (!area) return
          const laid = layoutArea(area, inList)
          pinAll(ns, { areas: { [listId]: laid.area }, nodes: laid.nodes })
        },
      },
      {
        label: 'Fit to its cards',
        disabled: !inList.length,
        onSelect: () => {
          const now = current(ns)
          const area = now.areas[listId]
          if (!area) return
          pinAll(ns, { areas: { [listId]: fitArea(area, inList.map(c => now.nodes[c.id]), inList.map(estimateHeight)) } })
        },
      },
      {
        label: 'Add a card here',
        onSelect: () => {
          const area = current(ns).areas[listId]
          if (area) startDraft({ x: area.x + NODE_W / 2 + 16, y: area.y + 60 }, listId)
        },
      },
      'separator',
      { label: 'Hide from the map', onSelect: () => saveMap({ ...board.map, hiddenLists: [...hidden, listId] }) },
      { label: 'Lay out every list again', onSelect: relayoutAll },
    ]
  }

  const computed = useMemo<MapNode[]>(() => {
    const areaNodes: AreaNode[] = shownLists.map(list => {
      const a = layout.areas[list.id]
      return {
        id: `${AREA}${list.id}`,
        type: 'area',
        position: { x: a.x, y: a.y },
        width: a.w,
        height: a.h,
        zIndex: 0,
        dragHandle: '.area-head',
        selectable: false,
        deletable: false,
        data: {
          listId: list.id,
          title: list.title,
          color: listColor(board, list.id),
          count: visible.filter(c => c.list === list.id).length,
          over: false,
          onMenu: () => {},
          onResizeEnd: () => {},
        },
      }
    })
    const cardNodes: CardNode[] = visible.map(card => ({
      id: card.id,
      type: 'card',
      position: layout.nodes[card.id],
      zIndex: 1,
      deletable: false,
      data: {
        card,
        color: listColor(board, card.list),
        listTitle: card.list === null ? 'idea' : (board.meta.lists.find(l => l.id === card.list)?.title ?? card.list),
        selectedForTackle: selected.includes(card.id),
      },
    }))
    return [...areaNodes, ...cardNodes]
  }, [board, shownLists, visible, layout, selected])

  const [nodes, setNodes] = useState<MapNode[]>(computed)
  useEffect(() => {
    setNodes(prev => {
      const before = new Map(prev.map(n => [n.id, n]))
      return computed.map(n => {
        const old = before.get(n.id)
        if (!old) return n
        const busy = old.dragging || old.resizing
        return {
          ...n,
          position: busy ? old.position : n.position,
          width: old.resizing ? old.width : n.width,
          height: old.resizing ? old.height : n.height,
          selected: old.selected,
          measured: old.measured,
        } as MapNode
      })
    })
  }, [computed])

  // An area's header and resizer call back with the nodes as they are then.
  const liveNodes = useRef(nodes)
  liveNodes.current = nodes
  const shown = useMemo(
    () =>
      nodes.map(n =>
        n.type === 'area'
          ? ({
              ...n,
              data: {
                ...n.data,
                over: overArea === n.data.listId,
                onMenu: (e: React.MouseEvent) => openContextMenu(e, areaMenu(n.data.listId, liveNodes.current)),
                onResizeEnd: (area: MapArea) => pinAll(liveNodes.current, { areas: { [n.data.listId]: area } }),
              },
            } as AreaNode)
          : n,
      ),
    // The handlers read the live nodes through the ref; the rest follows the board.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, overArea, board, visible, hidden, shownLists],
  )

  const edges = useMemo<Edge[]>(() => {
    const ids = new Set(visible.map(c => c.id))
    const seen = new Set<string>()
    const out: Edge[] = []
    for (const card of visible) {
      for (const link of card.links) {
        if (!ids.has(link)) continue
        const key = [card.id, link].sort().join('~')
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ id: key, source: card.id, target: link, type: 'floating' })
      }
    }
    return out
  }, [visible])

  const onNodesChange = useCallback((changes: NodeChange<MapNode>[]) => setNodes(ns => applyNodeChanges(changes, ns)), [])

  const centerOf = (n: MapNode): MapNodePos => ({
    x: n.position.x + (n.measured?.width ?? NODE_W) / 2,
    y: n.position.y + (n.measured?.height ?? 50) / 2,
  })

  const onNodeDragStart = (_: unknown, node: MapNode) => {
    if (node.type !== 'area') return
    const members = new Map<string, MapNodePos>()
    for (const n of nodes) if (n.type === 'card' && n.data.card.list === node.data.listId) members.set(n.id, n.position)
    dragStart.current = { area: node.position, members }
  }

  const onNodeDrag = (_: unknown, node: MapNode) => {
    if (node.type === 'area') {
      // A backdrop carries its cards.
      const start = dragStart.current
      if (!start) return
      const dx = node.position.x - start.area.x
      const dy = node.position.y - start.area.y
      setNodes(ns =>
        ns.map(n => {
          const from = start.members.get(n.id)
          return from ? { ...n, position: { x: from.x + dx, y: from.y + dy } } : n
        }),
      )
      return
    }
    const target = areaAt(current(nodes).areas, centerOf(node))
    setOverArea(target && target !== node.data.card.list ? target : null)
  }

  const onNodeDragStop = (_: unknown, node: MapNode, dragged: MapNode[]) => {
    setOverArea(null)
    dragStart.current = null
    const latest = nodes.map(n => dragged.find(d => d.id === n.id) ?? n)
    pinAll(latest)
    if (node.type === 'area') return
    // A card dropped on another list's backdrop joins that list.
    const areas = current(latest).areas
    for (const d of dragged) {
      if (d.type !== 'card') continue
      const target = areaAt(areas, centerOf(d))
      if (target && target !== d.data.card.list) void actions.updateCard(board.path, d.id, { list: target })
    }
  }

  const link = (from: string, to: string) => {
    if (from === to) return
    const source = board.cards.find(x => x.id === from)
    const target = board.cards.find(x => x.id === to)
    if (!source || !target || source.links.includes(to) || target.links.includes(from)) return
    void actions.updateCard(board.path, from, { links: [...source.links, to] })
  }

  /** A link dropped on a card's body links them; dropped on empty space, it writes a new card. */
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || state.toNode || !state.fromNode) return
    const point = 'changedTouches' in event ? event.changedTouches[0] : event
    const at = flow.screenToFlowPosition({ x: point.clientX, y: point.clientY })
    const fromId = state.fromNode.id
    const onCard = nodes.find(
      n =>
        n.type === 'card' &&
        n.id !== fromId &&
        at.x >= n.position.x &&
        at.x <= n.position.x + (n.measured?.width ?? NODE_W) &&
        at.y >= n.position.y &&
        at.y <= n.position.y + (n.measured?.height ?? 50),
    )
    if (onCard) return link(fromId, onCard.id)
    const source = board.cards.find(c => c.id === fromId)
    const list = areaAt(current(nodes).areas, at) ?? source?.list ?? null
    startDraft(at, list, fromId, { x: point.clientX, y: point.clientY })
  }

  const commitDraft = async (title: string) => {
    const d = draft
    setDraft(null)
    if (!d || !title.trim()) return
    try {
      const card = await api.cards.create(board.path, { title: title.trim(), list: d.list })
      pinAll(liveNodes.current, { nodes: { [card.id]: { x: d.at.x - NODE_W / 2, y: d.at.y - 18 } } })
      if (d.linkFrom) {
        const source = board.cards.find(c => c.id === d.linkFrom)
        if (source) void actions.updateCard(board.path, source.id, { links: [...source.links, card.id] })
      }
    } catch (error) {
      actions.toast((error as Error).message, 'error')
    }
  }

  const paneMenu = (at: MapNodePos): MenuItem[] => [
    { label: 'Add an idea here', hint: 'no list', onSelect: () => startDraft(at, null) },
    { label: 'Lay out every list again', onSelect: relayoutAll },
    { label: 'Fit everything in view', onSelect: () => void flow.fitView({ padding: 0.1 }) },
  ]

  const toggleList = (id: string) => {
    const next = new Set(hidden)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    saveMap({ ...board.map, hiddenLists: [...next] })
  }

  return (
    <div className="map-view">
      <div className="map-toolbar">
        <button
          className={`chip${showUnlisted ? ' on' : ''}`}
          onClick={() => saveMap({ ...board.map, showUnlisted: !showUnlisted })}
          title="Cards with no list: ideas that only live on the map"
        >
          <i style={{ background: listColor(board, null) }} /> Ideas
        </button>
        {board.meta.lists
          .filter(l => !l.archived)
          .map(list => (
            <button key={list.id} className={`chip${hidden.has(list.id) ? '' : ' on'}`} onClick={() => toggleList(list.id)}>
              <i style={{ background: listColor(board, list.id) }} /> {list.title}
            </button>
          ))}
        <span className="spacer" />
        <span className="muted hint">
          Double-click: a new card · drag a card's dot onto a card to link it, onto empty space for a new linked card ·
          right-click a backdrop to lay it out
        </span>
      </div>
      <div className="map-canvas" ref={container}>
        <ReactFlow<MapNode, Edge>
          nodes={shown}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onConnect={(c: Connection) => c.source && c.target && link(c.source, c.target)}
          onConnectEnd={onConnectEnd}
          onEdgesDelete={gone => {
            for (const edge of gone) {
              for (const [a, b] of [
                [edge.source, edge.target],
                [edge.target, edge.source],
              ]) {
                const card = board.cards.find(x => x.id === a)
                if (card?.links.includes(b)) void actions.updateCard(board.path, a, { links: card.links.filter(l => l !== b) })
              }
            }
          }}
          onNodeDoubleClick={(_, node) => node.type === 'card' && actions.openCard(board.path, node.id)}
          onNodeClick={(e, node) => {
            if (node.type === 'card' && (e.ctrlKey || e.metaKey || e.shiftKey)) actions.toggleSelected(board.path, node.id)
          }}
          onNodeContextMenu={(e, node) => {
            if (node.type === 'card') openContextMenu(e, cardMenu(board, node.data.card))
          }}
          onPaneClick={e => {
            if (e.detail !== 2) return
            const at = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
            startDraft(at, areaAt(current(nodes).areas, at) ?? null, undefined, { x: e.clientX, y: e.clientY })
          }}
          onPaneContextMenu={e => {
            // A backdrop's body lets the pane have its clicks: find the backdrop under the pointer.
            const at = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
            const area = areaAt(current(nodes).areas, at)
            openContextMenu(e, area ? areaMenu(area, nodes) : paneMenu(at))
          }}
          deleteKeyCode={['Delete', 'Backspace']}
          connectionMode={ConnectionMode.Loose}
          zoomOnDoubleClick={false}
          minZoom={0.08}
          maxZoom={2}
          fitView
          fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={n => (n.type === 'area' ? `${(n.data as AreaNodeData).color}40` : (n.data as CardNodeData).color)}
            maskColor="color-mix(in srgb, var(--bg) 70%, transparent)"
          />
        </ReactFlow>
        {draft && (
          <NewCardInput
            x={draft.screen.x}
            y={draft.screen.y}
            where={
              draft.list === null ? 'an idea (no list)' : `in ${board.meta.lists.find(l => l.id === draft.list)?.title ?? draft.list}`
            }
            linked={draft.linkFrom}
            onSubmit={title => void commitDraft(title)}
            onCancel={() => setDraft(null)}
          />
        )}
      </div>
    </div>
  )
}

/** The title of a card being added on the map. Enter adds it; Escape, or leaving it empty, adds nothing. */
function NewCardInput({
  x,
  y,
  where,
  linked,
  onSubmit,
  onCancel,
}: {
  x: number
  y: number
  where: string
  linked?: string
  onSubmit: (title: string) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const done = useRef(false)
  const finish = (submit: boolean) => {
    if (done.current) return
    done.current = true
    if (submit && title.trim()) onSubmit(title)
    else onCancel()
  }
  return (
    <div className="map-new-card" style={{ left: x, top: y }}>
      <input
        autoFocus
        value={title}
        placeholder="New card title"
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') finish(true)
          else if (e.key === 'Escape') {
            e.stopPropagation()
            finish(false)
          }
        }}
        onBlur={() => finish(true)}
      />
      <small>
        {where}
        {linked ? ` · linked from ${linked}` : ''} · Enter adds, Esc cancels
      </small>
    </div>
  )
}

/** A list's backdrop: dragged by its header, resized from its edges, right-click for its menu. */
const AreaNodeView = memo(function AreaNodeView({ data }: NodeProps<AreaNode>) {
  return (
    <div
      className={`map-area${data.over ? ' over' : ''}`}
      style={{ background: `${data.color}12`, borderColor: `${data.color}66` }}
      data-area={data.listId}
    >
      <NodeResizer
        minWidth={AREA_MIN_W}
        minHeight={AREA_MIN_H}
        color={data.color}
        handleClassName="area-handle"
        lineClassName="area-line"
        onResizeEnd={(_, p) => data.onResizeEnd({ x: p.x, y: p.y, w: p.width, h: p.height })}
      />
      <div className="area-head" style={{ color: data.color }} onContextMenu={data.onMenu} title="Drag to move the list with its cards">
        <span className="area-title">{data.title}</span>
        <span className="area-count">{data.count}</span>
        <button className="icon-button small nodrag" aria-label={`${data.title} actions`} onClick={data.onMenu}>
          ⋯
        </button>
      </div>
    </div>
  )
})

const CardNodeView = memo(function CardNodeView({ data, selected }: NodeProps<CardNode>) {
  const { card, color, listTitle, selectedForTackle } = data
  return (
    <div
      className={`map-node${selected ? ' selected' : ''}${selectedForTackle ? ' tackle' : ''}`}
      style={{ borderLeftColor: color }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="map-node-title" title={card.title}>
        {card.title}
      </div>
      <div className="map-node-meta">
        {card.id} · {listTitle}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
})

/** A straight link between the two cards' borders, wherever they sit: a mind map's edges. */
function FloatingEdge({ id, source, target, selected }: EdgeProps) {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  if (!s || !t) return null
  const [sx, sy] = borderPoint(s, t)
  const [tx, ty] = borderPoint(t, s)
  const [path] = getStraightPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty })
  return (
    <BaseEdge
      id={id}
      path={path}
      interactionWidth={14}
      style={{ stroke: selected ? 'var(--accent)' : 'var(--muted)', strokeWidth: selected ? 2.5 : 1.6 }}
    />
  )
}

function borderPoint(node: InternalNode, other: InternalNode): [number, number] {
  const w = (node.measured.width ?? NODE_W) / 2
  const h = (node.measured.height ?? 50) / 2
  const cx = node.internals.positionAbsolute.x + w
  const cy = node.internals.positionAbsolute.y + h
  const ox = other.internals.positionAbsolute.x + (other.measured.width ?? NODE_W) / 2
  const oy = other.internals.positionAbsolute.y + (other.measured.height ?? 50) / 2
  const dx = ox - cx
  const dy = oy - cy
  if (!dx && !dy) return [cx, cy]
  const scale = 1 / Math.max(Math.abs(dx) / w, Math.abs(dy) / h)
  return [cx + dx * scale, cy + dy * scale]
}

const NODE_TYPES = { card: CardNodeView, area: AreaNodeView }
const EDGE_TYPES = { floating: FloatingEdge }
