import { useEffect, useState } from 'react'
import type { BoardNode } from '@shared/types'
import { actions, api, useStore } from '../state'

type Menu = { node: BoardNode; x: number; y: number }

export function Sidebar() {
  const tree = useStore(s => s.tree)
  const config = useStore(s => s.config)
  const lastCommit = useStore(s => s.lastCommit)
  const [menu, setMenu] = useState<Menu | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">Corkboard</span>
        <button
          className="icon-button"
          title="New board"
          onClick={() => actions.setModal({ kind: 'newBoard', parent: '' })}
        >
          +
        </button>
      </div>
      <div className="tree" role="tree">
        {tree.map(node => (
          <TreeNode key={node.path} node={node} depth={0} onMenu={setMenu} />
        ))}
        {!tree.length && <p className="muted pad">No boards yet.</p>}
      </div>
      <div className="sidebar-foot" title={config?.boardRoot}>
        <button className="link" onClick={() => void actions.pickRoot()}>
          {config?.boardRoot.split('/').at(-1)}
        </button>
        {lastCommit && (
          <span className="commit-status" title={lastCommit.summary}>
            Committed {new Date(lastCommit.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}:{' '}
            {lastCommit.summary}
          </span>
        )}
      </div>
      <ResizeHandle />
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
          <button onClick={() => (setMenu(null), void actions.openBoard(menu.node.path))}>Open</button>
          <button onClick={() => (setMenu(null), void actions.openBoard(menu.node.path, 'map'))}>Open map</button>
          <button
            onClick={() => (setMenu(null), actions.setModal({ kind: 'newBoard', parent: menu.node.path }))}
          >
            New board inside…
          </button>
          <button onClick={() => (setMenu(null), void openSettings(menu.node.path))}>Settings…</button>
          <hr />
          <button
            className="danger"
            onClick={() => {
              setMenu(null)
              void deleteBoard(menu.node)
            }}
          >
            Delete board…
          </button>
        </div>
      )}
    </aside>
  )
}

async function openSettings(path: string) {
  if (!useStore.getState().boards[path]) await actions.loadBoard(path)
  actions.setModal({ kind: 'settings', path })
}

async function deleteBoard(node: BoardNode) {
  if (node.cardCount || node.children.length) {
    actions.toast('Only an empty board (no cards, no child boards) can be deleted.', 'error')
    return
  }
  const ok = await actions.confirm(`Delete “${node.title}”?`, 'Its folder is removed from the board repo.', 'Delete')
  if (!ok) return
  try {
    await api.boards.remove(node.path)
    actions.closeTab(node.path)
  } catch (error) {
    actions.toast((error as Error).message, 'error')
  }
}

function TreeNode({ node, depth, onMenu }: { node: BoardNode; depth: number; onMenu: (m: Menu) => void }) {
  const expanded = useStore(s => s.expanded.includes(node.path))
  const active = useStore(s => s.activeTab === node.path)
  const open = useStore(s => s.tabs.some(t => t.path === node.path))
  const hasChildren = node.children.length > 0
  const isFolder = node.listCount === 0 && hasChildren

  return (
    <div role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div
        className={`tree-row${active ? ' active' : ''}${open ? ' open' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => void actions.openBoard(node.path)}
        onContextMenu={e => {
          e.preventDefault()
          e.stopPropagation()
          onMenu({ node, x: e.clientX, y: e.clientY })
        }}
        title={`${node.path} (${node.key})`}
      >
        <button
          className={`twisty${hasChildren ? '' : ' hidden'}`}
          onClick={e => {
            e.stopPropagation()
            actions.toggleExpanded(node.path)
          }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className="tree-icon">{isFolder ? '▤' : '▦'}</span>
        <span className="tree-title">{node.title}</span>
        <span className="tree-count">{node.cardCount}</span>
      </div>
      {hasChildren && expanded && (
        <div role="group">
          {node.children.map(child => (
            <TreeNode key={child.path} node={child} depth={depth + 1} onMenu={onMenu} />
          ))}
        </div>
      )}
    </div>
  )
}

function ResizeHandle() {
  return (
    <div
      className="resize-x"
      onPointerDown={e => {
        const startX = e.clientX
        const start = useStore.getState().sidebarWidth
        const move = (ev: PointerEvent) =>
          useStore.setState({ sidebarWidth: Math.min(480, Math.max(180, start + ev.clientX - startX)) })
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
    />
  )
}
