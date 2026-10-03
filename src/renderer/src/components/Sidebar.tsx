import type { BoardNode } from '@shared/types'
import { actions, api, useStore } from '../state'
import { openContextMenu, type MenuItem } from './ContextMenu'

export function Sidebar() {
  const tree = useStore(s => s.tree)
  const config = useStore(s => s.config)

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
          <TreeNode key={node.path} node={node} depth={0} />
        ))}
        {!tree.length && <p className="muted pad">No boards yet.</p>}
      </div>
      <footer className="sidebar-foot">
        <button className="link repo-name" title={`${config?.boardRoot}\nClick to open another board repo`} onClick={() => void actions.pickRoot()}>
          {config?.boardRoot.split('/').at(-1)}
        </button>
        <SyncLine />
        <ClaudeLine />
      </footer>
      <ResizeHandle />
    </aside>
  )
}

function boardMenu(node: BoardNode): MenuItem[] {
  return [
    { label: 'Open', onSelect: () => void actions.openBoard(node.path) },
    { label: 'Open map', onSelect: () => void actions.openBoard(node.path, 'map') },
    { label: 'Open table', onSelect: () => void actions.openBoard(node.path, 'table') },
    'separator',
    { label: 'New board inside…', onSelect: () => actions.setModal({ kind: 'newBoard', parent: node.path }) },
    { label: 'Settings…', onSelect: () => void openSettings(node.path) },
    { label: 'Open a terminal here', hint: 'its code repo', onSelect: () => void actions.newTerminal(node.path) },
    { label: 'Copy key', hint: node.key, onSelect: () => actions.copy(node.key) },
    'separator',
    { label: 'Delete board…', danger: true, onSelect: () => void deleteBoard(node) },
  ]
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

function TreeNode({ node, depth }: { node: BoardNode; depth: number }) {
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
        onContextMenu={e => openContextMenu(e, boardMenu(node))}
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
            <TreeNode key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

const time = (at?: number) =>
  at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''

/** Where the board repo stands against its remote, and a button to sync now. */
function SyncLine() {
  const sync = useStore(s => s.sync)
  const lastCommit = useStore(s => s.lastCommit)
  const text: Record<typeof sync.state, string> = {
    idle: 'Not synced yet',
    local: 'No remote: this machine only',
    syncing: 'Syncing…',
    synced: `Synced ${time(sync.at)}${sync.pulled ? ` · ${sync.pulled} in` : ''}`,
    offline: `Offline${sync.at ? ` · synced ${time(sync.at)}` : ''}`,
    conflict: 'Sync stopped: conflict',
  }
  const tip = [
    sync.message,
    lastCommit ? `Last commit ${time(lastCommit.at)}: ${lastCommit.summary}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <div className={`foot-line sync-${sync.state}`} title={tip || undefined}>
      <span className="dot" />
      <span className="foot-text">{text[sync.state]}</span>
      {sync.state !== 'local' && (
        <button className="foot-button" disabled={sync.state === 'syncing'} onClick={() => void actions.syncNow()}>
          Sync
        </button>
      )}
    </div>
  )
}

/** The Claude Code the terminals run, and a button that updates it in a terminal tab. */
function ClaudeLine() {
  const claude = useStore(s => s.claude)
  return (
    <div className="foot-line" title={claude?.path ?? claude?.error}>
      <span className="foot-text">
        {claude ? (claude.version ? `Claude Code ${claude.version}` : 'Claude Code not found') : 'Claude Code…'}
      </span>
      <button className="foot-button" onClick={() => void actions.updateClaude()} title="Runs `claude update` in a terminal tab">
        Update
      </button>
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
