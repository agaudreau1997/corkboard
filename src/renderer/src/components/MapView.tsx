import {
  applyNodeChanges,
  Background,
  BaseEdge,
  ConnectionMode,
  Controls,
  getStraightPath,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useInternalNode,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type InternalNode,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { isDivider } from '@shared/cardfile'
import type { BoardMap, Card, LoadedBoard, MapNodePos } from '@shared/types'
import { cardMenu } from '../menus'
import { actions, api, listColor, useStore, NONE } from '../state'
import { openContextMenu } from './ContextMenu'

type CardNodeData = { card: Card; color: string; listTitle: string; selectedForTackle: boolean }
type CardNode = Node<CardNodeData, 'card'>

const COL_W = 260
const GAP = 14
const LIST_GAP = 70
const MAX_COLUMN_HEIGHT = 1100

export function MapView(props: { board: LoadedBoard; matches: (c: Card) => boolean }) {
  return (
    <ReactFlowProvider>
      <MapCanvas {...props} />
    </ReactFlowProvider>
  )
}

function MapCanvas({ board, matches }: { board: LoadedBoard; matches: (c: Card) => boolean }) {
  const selected = useStore(s => s.selected[board.path] ?? NONE)
  const flow = useReactFlow()
  const hidden = useMemo(() => new Set(board.map.hiddenLists ?? []), [board.map.hiddenLists])
  const showUnlisted = board.map.showUnlisted !== false

  const visible = useMemo(
    () =>
      board.cards.filter(
        c =>
          !c.archived &&
          !isDivider(c) &&
          matches(c) &&
          (c.list === null ? showUnlisted : !hidden.has(c.list) && board.meta.lists.some(l => l.id === c.list)),
      ),
    [board, matches, hidden, showUnlisted],
  )

  const computed = useMemo<CardNode[]>(() => {
    const auto = autoLayout(board, visible)
    return visible.map(card => ({
      id: card.id,
      type: 'card',
      position: board.map.nodes[card.id] ?? auto[card.id],
      deletable: false,
      data: {
        card,
        color: listColor(board, card.list),
        listTitle: card.list === null ? 'idea' : (board.meta.lists.find(l => l.id === card.list)?.title ?? card.list),
        selectedForTackle: selected.includes(card.id),
      },
    }))
  }, [board, visible, selected])

  const [nodes, setNodes] = useState<CardNode[]>(computed)
  useEffect(() => {
    setNodes(prev => {
      const before = new Map(prev.map(n => [n.id, n]))
      return computed.map(n => {
        const old = before.get(n.id)
        return old ? { ...n, position: old.dragging ? old.position : n.position, selected: old.selected, measured: old.measured } : n
      })
    })
  }, [computed])

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

  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) => setNodes(ns => applyNodeChanges(changes, ns)),
    [],
  )

  const saveMap = useCallback(
    (map: BoardMap) => {
      actions.setMapLocal(board.path, map)
      void api.map.save(board.path, map)
    },
    [board.path],
  )

  // A drag pins every card on screen where it stands, not just the dragged ones: the cards
  // still on the automatic layout would otherwise be laid out again around the moved one.
  const onNodeDragStop = useCallback(
    (_: unknown, __: CardNode, dragged: CardNode[]) => {
      const placed: Record<string, MapNodePos> = {}
      for (const n of nodes) placed[n.id] = { x: n.position.x, y: n.position.y }
      for (const n of dragged) placed[n.id] = { x: n.position.x, y: n.position.y }
      saveMap({ ...board.map, nodes: { ...board.map.nodes, ...placed } })
    },
    [board.map, nodes, saveMap],
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return
      const source = board.cards.find(x => x.id === c.source)
      const target = board.cards.find(x => x.id === c.target)
      if (!source || !target || source.links.includes(target.id) || target.links.includes(source.id)) return
      void actions.updateCard(board.path, source.id, { links: [...source.links, target.id] })
    },
    [board],
  )

  const onEdgesDelete = useCallback(
    (gone: Edge[]) => {
      for (const edge of gone) {
        for (const [a, b] of [
          [edge.source, edge.target],
          [edge.target, edge.source],
        ]) {
          const card = board.cards.find(x => x.id === a)
          if (card?.links.includes(b))
            void actions.updateCard(board.path, a, { links: card.links.filter(l => l !== b) })
        }
      }
    },
    [board],
  )

  const addIdea = async (event: React.MouseEvent) => {
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    try {
      const card = await api.cards.create(board.path, { title: 'New idea', list: null })
      saveMap({
        ...board.map,
        showUnlisted: true,
        nodes: { ...board.map.nodes, [card.id]: { x: at.x - 110, y: at.y - 24 } },
      })
      actions.openCard(board.path, card.id)
    } catch (error) {
      actions.toast((error as Error).message, 'error')
    }
  }

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
        {board.meta.lists.map(list => (
          <button
            key={list.id}
            className={`chip${hidden.has(list.id) ? '' : ' on'}`}
            onClick={() => toggleList(list.id)}
          >
            <i style={{ background: listColor(board, list.id) }} /> {list.title}
          </button>
        ))}
        <span className="spacer" />
        <span className="muted hint">Double-click to add an idea · drag dot to dot to link · select a link and press Delete</span>
      </div>
      <div className="map-canvas">
        <ReactFlow<CardNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onConnect={onConnect}
          onEdgesDelete={onEdgesDelete}
          onNodeDoubleClick={(_, node) => actions.openCard(board.path, node.id)}
          onNodeContextMenu={(e, node) => {
            const card = board.cards.find(c => c.id === node.id)
            if (card) openContextMenu(e, cardMenu(board, card))
          }}
          onNodeClick={(e, node) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey) actions.toggleSelected(board.path, node.id)
          }}
          onPaneClick={e => {
            if (e.detail === 2) void addIdea(e)
          }}
          deleteKeyCode={['Delete', 'Backspace']}
          connectionMode={ConnectionMode.Loose}
          zoomOnDoubleClick={false}
          minZoom={0.1}
          maxZoom={2}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={n => (n.data as CardNodeData).color} maskColor="rgba(10,12,16,0.7)" />
        </ReactFlow>
      </div>
    </div>
  )
}

/**
 * Cards with no saved position: one block per list (ideas first), stacked by an estimate of each
 * card's height and wrapped into sub-columns, placed to the right of whatever was placed by hand.
 */
function autoLayout(board: LoadedBoard, cards: Card[]): Record<string, MapNodePos> {
  const placed = Object.values(board.map.nodes)
  const originX = placed.length ? Math.max(...placed.map(p => p.x)) + COL_W * 1.5 : 0
  const order = [null, ...board.meta.lists.map(l => l.id)]
  const out: Record<string, MapNodePos> = {}
  let x = originX
  for (const listId of order) {
    const inList = cards.filter(c => c.list === listId && !board.map.nodes[c.id])
    if (!inList.length) continue
    let y = 0
    for (const card of inList) {
      const height = estimateHeight(card)
      if (y > 0 && y + height > MAX_COLUMN_HEIGHT) {
        x += COL_W
        y = 0
      }
      out[card.id] = { x, y }
      y += height + GAP
    }
    x += COL_W + LIST_GAP
  }
  return out
}

/** A map node is 230 px wide, about 32 characters a line, at most four lines of title. */
function estimateHeight(card: Card): number {
  const lines = Math.min(4, Math.max(1, Math.ceil(card.title.length / 32)))
  return 36 + lines * 18
}

const CardNodeView = memo(function CardNodeView({ data, selected }: NodeProps<CardNode>) {
  const { card, color, listTitle, selectedForTackle } = data
  return (
    <div className={`map-node${selected ? ' selected' : ''}${selectedForTackle ? ' tackle' : ''}`} style={{ borderLeftColor: color }}>
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
      style={{ stroke: selected ? '#f0c674' : '#7b8496', strokeWidth: selected ? 2.5 : 1.6 }}
    />
  )
}

function borderPoint(node: InternalNode, other: InternalNode): [number, number] {
  const w = (node.measured.width ?? 220) / 2
  const h = (node.measured.height ?? 50) / 2
  const cx = node.internals.positionAbsolute.x + w
  const cy = node.internals.positionAbsolute.y + h
  const ox = other.internals.positionAbsolute.x + (other.measured.width ?? 220) / 2
  const oy = other.internals.positionAbsolute.y + (other.measured.height ?? 50) / 2
  const dx = ox - cx
  const dy = oy - cy
  if (!dx && !dy) return [cx, cy]
  const scale = 1 / Math.max(Math.abs(dx) / w, Math.abs(dy) / h)
  return [cx + dx * scale, cy + dy * scale]
}

const NODE_TYPES = { card: CardNodeView }
const EDGE_TYPES = { floating: FloatingEdge }
