import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { CSSProperties, ReactNode } from 'react'
import { inOrder } from '@shared/sideorder'
import type { BoardNode, ProjectNode, SyncStatus, UpdateStatus } from '@shared/types'
import { actions, api, projectIdOf, useStore } from '../state'
import { discussBoard } from '../tackle'
import { openContextMenu, type MenuItem } from './ContextMenu'
import { ProjectMark } from './ProjectMark'

/** The menu of the side panel's own space: its header, and below the projects. */
const panelMenu = (): MenuItem[] => [{ label: 'Add project…', onSelect: () => actions.setModal({ kind: 'addProject' }) }]

export function Sidebar() {
  const order = useStore(s => s.config?.order?.projects)
  const projects = inOrder(useStore(s => s.projects), p => p.id, order)

  return (
    <aside className="sidebar">
      <div className="sidebar-head" onContextMenu={e => openContextMenu(e, panelMenu())}>
        <span className="brand">Corkboard</span>
        <button className="icon-button" title="Add project" onClick={() => actions.setModal({ kind: 'addProject' })}>
          +
        </button>
      </div>
      {/* A row's own menu stops here (`openContextMenu` stops the event), so this one is the
          space around and below them. */}
      <div className="tree" role="tree" onContextMenu={e => openContextMenu(e, panelMenu())}>
        <Reorder ids={projects.map(p => p.id)} onReorder={ids => void actions.reorder('projects', ids)}>
          {projects.map(project => (
            <ProjectRow key={project.id} project={project} />
          ))}
        </Reorder>
        {!projects.length && <p className="muted pad">No projects yet.</p>}
      </div>
      <footer className="sidebar-foot">
        <div className="foot-line">
          <button
            className="link app-settings"
            onClick={() => actions.setModal({ kind: 'appSettings' })}
            title="This machine's settings: desktop notifications and the notification program"
          >
            Corkboard settings…
          </button>
        </div>
        <UpdateLine />
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

/**
 * A project: one board repo, its sync state, and its boards below it. The row is the way in to its
 * main board, so that board's own row isn't repeated: its child boards and the project's other
 * top-level boards are listed under the project, and only the arrow folds them.
 */
function ProjectRow({ project }: { project: ProjectNode }) {
  const folded = useStore(s => s.foldedProjects.includes(project.id))
  const lastCommit = useStore(s => (s.lastCommit?.projectId === project.id ? s.lastCommit : null))
  const declined = useStore(s => s.noGuide.includes(project.id))
  const active = useStore(s => !!project.mainBoard && s.activeTab === project.mainBoard)
  const open = useStore(s => s.tabs.some(t => t.path === project.mainBoard))
  const boardOrder = useStore(s => s.config?.order?.boards)
  const drag = useReorderable(project.id)
  const main = project.boards.find(b => b.path === project.mainBoard)
  // One sibling list, in this machine's order: the main board's children and the other top-level boards.
  const listed = inOrder([...(main?.children ?? []), ...project.boards.filter(b => b !== main)], b => b.path, boardOrder)
  const offer = !project.guide && !declined
  const tip = [
    main ? `Opens ${main.title} (${main.key}), the main board` : undefined,
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
    <div
      role="treeitem"
      aria-expanded={!folded}
      className={`project${drag.dragging ? ' dragging' : ''}`}
      data-project={project.id}
      ref={drag.ref}
      style={drag.style}
    >
      <div
        className={`project-row sync-${project.sync.state}${active ? ' active' : ''}${open ? ' open' : ''}`}
        title={tip}
        onClick={() => main && void actions.openBoard(main.path)}
        onContextMenu={e => openContextMenu(e, projectMenu(project))}
      >
        {drag.handle}
        <Twisty open={!folded} hidden={!listed.length && !offer && !!main} onToggle={toggle} />
        <ProjectMark project={project} title={project.icon ? undefined : `Colours: ${project.theme?.name ?? 'custom'}`} />
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
          <BoardList nodes={listed} depth={1} />
          {/* A project added now always has its main board: only a repo emptied by hand, or made
              by an older build, has none and needs this way in. */}
          {!project.boards.length && (
            <button
              className="link empty-project"
              onClick={() => actions.setModal({ kind: 'newBoard', parent: `${project.id}:` })}
            >
              + New board
            </button>
          )}
          {offer && <GuideOffer project={project} />}
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
  const main = project.boards.find(b => b.path === project.mainBoard)
  return [
    { heading: project.name },
    ...(main ? [{ label: 'Main board', hint: main.title, items: boardMenu(main) }] : []),
    { label: 'New board…', onSelect: () => actions.setModal({ kind: 'newBoard', parent: `${project.id}:` }) },
    {
      label: 'Sync now',
      hint: syncText(project.sync),
      disabled: project.sync.state === 'local',
      onSelect: () => void actions.syncNow(project.id),
    },
    {
      label: 'Project settings…',
      hint: 'name, main board, colours',
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
  // The main board stays while it is the main one: the project opens there.
  const main = projects.find(p => p.id === here)?.mainBoard === node.path
  const mainHint = 'the main board: pick another first'
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
    { label: 'Board settings…', onSelect: () => void openSettings(node.path) },
    { label: 'Open a terminal here', hint: 'its code repo', onSelect: () => void actions.newTerminal(node.path) },
    { label: 'Copy key', hint: node.key, onSelect: () => actions.copy(node.key) },
    {
      label: 'Move to project',
      hint: main ? mainHint : undefined,
      disabled: !others.length || main,
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
    {
      label: 'Delete board…',
      hint: main ? mainHint : undefined,
      danger: true,
      disabled: main,
      onSelect: () => void deleteBoard(node),
    },
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
  const boardOrder = useStore(s => s.config?.order?.boards)
  const drag = useReorderable(node.path)
  const hasChildren = node.children.length > 0
  const isFolder = node.listCount === 0 && hasChildren

  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      className={drag.dragging ? 'dragging' : undefined}
      ref={drag.ref}
      style={drag.style}
    >
      <div
        className={`tree-row${active ? ' active' : ''}${open ? ' open' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => void actions.openBoard(node.path)}
        onContextMenu={e => openContextMenu(e, boardMenu(node))}
        title={`${node.path.slice(node.path.indexOf(':') + 1)} (${node.key})`}
      >
        {drag.handle}
        <Twisty open={expanded} hidden={!hasChildren} onToggle={() => actions.toggleExpanded(node.path)} />
        <span className="tree-icon">{isFolder ? '▤' : '▦'}</span>
        <span className="tree-title">{node.title}</span>
        <span className="tree-count">{node.cardCount}</span>
      </div>
      {hasChildren && expanded && (
        <div role="group">
          <BoardList nodes={inOrder(node.children, b => b.path, boardOrder)} depth={depth + 1} />
        </div>
      )}
    </div>
  )
}

/** Sibling boards, in the order they are given, reordered by their handles. */
function BoardList({ nodes, depth }: { nodes: BoardNode[]; depth: number }) {
  return (
    <Reorder ids={nodes.map(n => n.path)} onReorder={ids => void actions.reorder('boards', ids)}>
      {nodes.map(node => (
        <TreeNode key={node.path} node={node} depth={depth} />
      ))}
    </Reorder>
  )
}

/**
 * One sibling list of the side panel, reordered by its rows' handles. Each list is a drag context
 * of its own, so a board only lands among its siblings (moving it elsewhere is *Move to project*)
 * and a project among the projects.
 */
function Reorder({ ids, onReorder, children }: { ids: string[]; onReorder: (ids: string[]) => void; children: ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const from = ids.indexOf(String(active.id))
    const to = over ? ids.indexOf(String(over.id)) : -1
    if (from >= 0 && to >= 0 && from !== to) onReorder(arrayMove(ids, from, to))
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  )
}

/**
 * A row of a `Reorder` list: its node's ref and style (moved up and down only), and its ⣿ handle,
 * the only place a drag starts, so a click on the row still opens it and the arrow still folds.
 */
function useReorderable(id: string) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({ id })
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform && { ...transform, x: 0 }),
    transition,
    position: 'relative',
    zIndex: isDragging ? 2 : undefined,
  }
  const handle = (
    <span
      className="drag-handle"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label="Drag to reorder"
      title="Drag to reorder"
      onClick={e => e.stopPropagation()}
    >
      ⣿
    </span>
  )
  return { ref: setNodeRef, style, handle, dragging: isDragging }
}

/** The arrow that folds a project or a board's children, and nothing else: a click on it stays on it. */
function Twisty({ open, hidden, onToggle }: { open: boolean; hidden?: boolean; onToggle: () => void }) {
  return (
    <button
      className={`twisty${open ? ' open' : ''}${hidden ? ' hidden' : ''}`}
      aria-label={open ? 'Collapse' : 'Expand'}
      aria-expanded={open}
      tabIndex={hidden ? -1 : undefined}
      onClick={e => {
        e.stopPropagation()
        onToggle()
      }}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M6 3.5 10.5 8 6 12.5" />
      </svg>
    </button>
  )
}

/** What the line says about an update, and what its button does. */
function updateText(u: UpdateStatus): { text: string; tip: string; button?: { label: string; tip: string; run: () => void } } {
  const notes = u.page ? '\nClick for the release notes.' : ''
  const check = { label: 'Check', tip: 'Looks for a newer release now', run: () => void api.updates.check() }
  switch (u.state) {
    case 'off':
      return { text: `Corkboard ${u.current}`, tip: `Updates are off: ${u.message ?? 'not this copy'}.` }
    case 'checking':
      return { text: `Corkboard ${u.current} · checking…`, tip: `Looking for a newer release.${notes}` }
    case 'current':
      return { text: `Corkboard ${u.current} · up to date`, tip: `No newer release.${notes}`, button: check }
    case 'available':
      return {
        text: `Corkboard ${u.version} is out`,
        tip: `You run ${u.current}.${notes}`,
        button: {
          label: 'Download',
          tip: "Opens the release page. The portable exe can't update itself; the installer can.",
          run: () => u.page && api.shell.openExternal(u.page),
        },
      }
    case 'downloading':
      return { text: `Corkboard ${u.version} · downloading ${u.percent ?? 0}%`, tip: `You run ${u.current}.${notes}` }
    case 'ready':
      return {
        text: `Corkboard ${u.version} is ready`,
        tip: `You run ${u.current}; ${u.version} installs at the next quit, or now.${notes}`,
        button: { label: 'Restart to update', tip: 'Installs it and starts Corkboard again', run: () => void actions.restartToUpdate() },
      }
    case 'installing':
      return { text: `Installing Corkboard ${u.version}…`, tip: 'Committing and pushing the boards first.' }
    case 'error':
      return { text: `Corkboard ${u.current} · update check failed`, tip: `${u.message ?? 'The update check failed.'}${notes}`, button: check }
  }
}

/** Corkboard's own version, and its updates; the version opens its release notes. */
function UpdateLine() {
  const update = useStore(s => s.update)
  if (!update) return null
  const { text, tip, button } = updateText(update)
  return (
    <div className={`foot-line update-line update-${update.state}`} title={tip}>
      {update.page ? (
        <button className="link foot-text" onClick={() => update.page && api.shell.openExternal(update.page)}>
          {text}
        </button>
      ) : (
        <span className="foot-text">{text}</span>
      )}
      {button && (
        <button className="foot-button" title={button.tip} onClick={button.run}>
          {button.label}
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
