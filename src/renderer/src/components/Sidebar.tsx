import type { BoardNode, ProjectNode, SyncStatus } from '@shared/types'
import { actions, api, projectIdOf, useStore } from '../state'
import { discussBoard } from '../tackle'
import { openContextMenu, type MenuItem } from './ContextMenu'
import { ThemeSwatch } from './ThemeEditor'

export function Sidebar() {
  const projects = useStore(s => s.projects)
  const activeTab = useStore(s => s.activeTab)

  // "New board" lands in the project of the board in front, else the first one.
  const currentProject = activeTab ? projectIdOf(activeTab) : projects[0]?.id

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">Corkboard</span>
        <button
          className="icon-button"
          title="New board"
          disabled={!currentProject}
          onClick={() => currentProject && actions.setModal({ kind: 'newBoard', parent: `${currentProject}:` })}
        >
          +
        </button>
      </div>
      <div className="tree" role="tree">
        {projects.map(project => (
          <ProjectRow key={project.id} project={project} />
        ))}
        {!projects.length && <p className="muted pad">No projects yet.</p>}
      </div>
      <footer className="sidebar-foot">
        <button className="link add-project" onClick={() => actions.setModal({ kind: 'addProject' })}>
          + Add project
        </button>
        <ClaudeLine />
      </footer>
      <ResizeHandle />
    </aside>
  )
}

const time = (at?: number) => (at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')

function syncText(sync: SyncStatus): string {
  switch (sync.state) {
    case 'idle':
      return 'Not synced yet'
    case 'local':
      return 'No remote: this machine only'
    case 'syncing':
      return 'Syncing…'
    case 'synced':
      return `Synced ${time(sync.at)}${sync.pulled ? ` · ${sync.pulled} in` : ''}`
    case 'offline':
      return `Offline${sync.at ? ` · synced ${time(sync.at)}` : ''}`
    case 'conflict':
      return 'Sync stopped: conflict'
  }
}

/** A project: one board repo, its sync state, and its boards below it. */
function ProjectRow({ project }: { project: ProjectNode }) {
  const folded = useStore(s => s.foldedProjects.includes(project.id))
  const lastCommit = useStore(s => (s.lastCommit?.projectId === project.id ? s.lastCommit : null))
  const declined = useStore(s => s.noGuide.includes(project.id))
  const tip = [
    project.root,
    project.codeRepo ? `Code folder: ${project.codeRepo}` : 'No code folder set on this machine',
    syncText(project.sync),
    project.sync.message,
    lastCommit ? `Last commit ${time(lastCommit.at)}: ${lastCommit.summary}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
  const toggle = () =>
    useStore.setState(s => ({
      foldedProjects: folded ? s.foldedProjects.filter(p => p !== project.id) : [...s.foldedProjects, project.id],
    }))

  return (
    <div role="treeitem" aria-expanded={!folded} className="project" data-project={project.id}>
      <div
        className={`project-row sync-${project.sync.state}`}
        title={tip}
        onClick={toggle}
        onContextMenu={e => openContextMenu(e, projectMenu(project))}
      >
        <span className="twisty-mark">{folded ? '▸' : '▾'}</span>
        {project.theme && <ThemeSwatch theme={project.theme} title={`Colours: ${project.theme.name ?? 'custom'}`} />}
        <span className="project-name">{project.name}</span>
        <span className="dot" aria-label={syncText(project.sync)} />
        <button
          className="icon-button small"
          aria-label={`${project.name} actions`}
          onClick={e => {
            e.stopPropagation()
            openContextMenu(e, projectMenu(project))
          }}
        >
          ⋯
        </button>
      </div>
      {!folded && (
        <div role="group">
          {project.boards.map(node => (
            <TreeNode key={node.path} node={node} depth={1} />
          ))}
          {!project.boards.length && (
            <button
              className="link empty-project"
              onClick={() => actions.setModal({ kind: 'newBoard', parent: `${project.id}:` })}
            >
              + New board
            </button>
          )}
          {!project.guide && !declined && <GuideOffer project={project} />}
        </div>
      )}
    </div>
  )
}

/**
 * A board repo made before the app wrote a CLAUDE.md (or by hand) has none, and the prompts then
 * say nothing about the card format. The app adds files to a repo only when asked: it offers, once
 * per project; the project's menu keeps the offer after a "No".
 */
function GuideOffer({ project }: { project: ProjectNode }) {
  const decline = () => useStore.setState(s => ({ noGuide: [...s.noGuide, project.id] }))
  return (
    <div
      className="guide-offer"
      title={`A CLAUDE.md in ${project.root} tells the Claude sessions started for its cards (and anyone editing them by hand) how a card file is written.`}
    >
      <span>No CLAUDE.md describes the card format to Claude sessions.</span>
      <span className="guide-offer-actions">
        <button className="link" onClick={() => void actions.addGuide(project.id)}>
          Add one
        </button>
        <button className="link muted" onClick={decline}>
          No thanks
        </button>
      </span>
    </div>
  )
}

function projectMenu(project: ProjectNode): MenuItem[] {
  return [
    { heading: project.name },
    { label: 'New board…', onSelect: () => actions.setModal({ kind: 'newBoard', parent: `${project.id}:` }) },
    {
      label: 'Sync now',
      hint: syncText(project.sync),
      disabled: project.sync.state === 'local',
      onSelect: () => void actions.syncNow(project.id),
    },
    {
      label: 'Settings…',
      hint: 'name, code folder, colours',
      onSelect: () => actions.setModal({ kind: 'projectSettings', id: project.id }),
    },
    { label: 'Open the board repo folder', onSelect: () => api.shell.openPath(project.root) },
    ...(project.guide
      ? []
      : [{ label: 'Add a CLAUDE.md', hint: 'the card format, for Claude', onSelect: () => void actions.addGuide(project.id) }]),
    'separator',
    {
      label: 'Remove from Corkboard…',
      danger: true,
      onSelect: async () => {
        const ok = await actions.confirm(
          `Remove “${project.name}” from Corkboard?`,
          `Only from this app's list on this machine: the board repo at ${project.root} stays as it is, and you can add it again.`,
          'Remove project',
        )
        if (ok) await actions.removeProject(project.id)
      },
    },
  ]
}

function boardMenu(node: BoardNode): MenuItem[] {
  const projects = useStore.getState().projects
  const here = projectIdOf(node.path)
  const others = projects.filter(p => p.id !== here)
  const desktop = useStore.getState().desktop
  const discuss = (mode: 'desktop' | 'local') => () => void discussBoard(node.path, mode)
  return [
    { label: 'Open', onSelect: () => void actions.openBoard(node.path) },
    { label: 'Open map', onSelect: () => void actions.openBoard(node.path, 'map') },
    { label: 'Open table', onSelect: () => void actions.openBoard(node.path, 'table') },
    'separator',
    {
      label: 'Discuss / triage',
      hint: 'no implementing',
      disabled: !node.cardCount,
      items: [
        ...(desktop ? [{ label: 'In Claude desktop', onSelect: discuss('desktop') }] : []),
        { label: 'In a terminal', onSelect: discuss('local') },
      ],
    },
    'separator',
    { label: 'New board inside…', onSelect: () => actions.setModal({ kind: 'newBoard', parent: node.path }) },
    { label: 'Settings…', onSelect: () => void openSettings(node.path) },
    { label: 'Open a terminal here', hint: 'its code repo', onSelect: () => void actions.newTerminal(node.path) },
    { label: 'Copy key', hint: node.key, onSelect: () => actions.copy(node.key) },
    {
      label: 'Move to project',
      disabled: !others.length,
      items: others.map(p => ({
        label: p.name,
        onSelect: async () => {
          const ok = await actions.confirm(
            `Move “${node.title}” to ${p.name}?`,
            `The board folder${node.children.length ? ' and its child boards' : ''} moves to the top of ${p.name}'s board repo, cards and ids as they are. It is committed out of this repo and into that one.`,
            'Move board',
          )
          if (!ok) return
          try {
            const key = await api.boards.moveToProject(node.path, p.id)
            actions.closeTab(node.path)
            await actions.refreshTree()
            await actions.openBoard(key)
          } catch (error) {
            actions.toast((error as Error).message, 'error')
          }
        },
      })),
    },
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
    // A board with cards asks for its name to be typed (in the modal).
    actions.setModal({ kind: 'deleteBoard', path: node.path })
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
        title={`${node.path.slice(node.path.indexOf(':') + 1)} (${node.key})`}
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
