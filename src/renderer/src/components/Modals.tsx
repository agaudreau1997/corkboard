import { useEffect, useState } from 'react'
import { slugify } from '@shared/cardfile'
import type { BoardMeta, ListDef } from '@shared/types'
import { actions, api, findNode, useStore } from '../state'

export function Modals() {
  const modal = useStore(s => s.modal)
  useEffect(() => {
    if (!modal) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && actions.setModal(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal])
  if (!modal) return null
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && actions.setModal(null)}>
      <div className="modal" role="dialog" aria-modal="true">
        {modal.kind === 'newBoard' && <NewBoard parent={modal.parent} />}
        {modal.kind === 'settings' && <Settings path={modal.path} />}
        {modal.kind === 'addProject' && <AddProject />}
        {modal.kind === 'projectSettings' && <ProjectSettings id={modal.id} />}
        {modal.kind === 'deleteBoard' && <DeleteBoard path={modal.path} />}
        {modal.kind === 'confirm' && (
          <>
            <h2>{modal.title}</h2>
            <p>{modal.body}</p>
            <div className="modal-actions">
              <button className="ghost" onClick={() => actions.setModal(null)}>
                Cancel
              </button>
              <button
                className="accent"
                autoFocus
                onClick={() => {
                  modal.onConfirm()
                  actions.setModal(null)
                }}
              >
                {modal.confirm}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function deriveKey(title: string): string {
  const words = title.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  return words.length >= 2 ? words.map(w => w[0]).join('').slice(0, 4) : (words[0] ?? '').slice(0, 4)
}

function NewBoard({ parent }: { parent: string }) {
  const tree = useStore(s => s.tree)
  const projects = useStore(s => s.projects)
  const [title, setTitle] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  // A parent ending in ':' is a project's top level.
  const atTop = parent.endsWith(':')
  const parentNode = atTop ? undefined : findNode(tree, parent)
  const project = projects.find(p => p.id === parent.slice(0, parent.indexOf(':')))

  const create = async () => {
    if (!title.trim()) return
    try {
      const path = await api.boards.create(parent, title.trim(), (keyTouched ? key : deriveKey(title)) || undefined)
      actions.setModal(null)
      if (!atTop && !useStore.getState().expanded.includes(parent)) actions.toggleExpanded(parent)
      await actions.refreshTree()
      await actions.openBoard(path)
    } catch (error) {
      actions.toast((error as Error).message, 'error')
    }
  }

  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        void create()
      }}
    >
      <h2>
        New board {parentNode ? `inside “${parentNode.title}”` : projects.length > 1 && project ? `in ${project.name}` : ''}
      </h2>
      <label className="field">
        <span>Title</span>
        <input
          autoFocus
          value={title}
          onChange={e => {
            setTitle(e.target.value)
            if (!keyTouched) setKey(deriveKey(e.target.value))
          }}
        />
      </label>
      <label className="field">
        <span>Card key</span>
        <input
          value={key}
          maxLength={8}
          onChange={e => {
            setKeyTouched(true)
            setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
          }}
        />
        <small className="muted">Cards are numbered {key || 'KEY'}-1, {key || 'KEY'}-2… (made unique in the repo).</small>
      </label>
      <p className="muted small">It starts with To do / Doing / Done; change the lists in its settings.</p>
      <div className="modal-actions">
        <button type="button" className="ghost" onClick={() => actions.setModal(null)}>
          Cancel
        </button>
        <button type="submit" className="accent" disabled={!title.trim()}>
          Create board
        </button>
      </div>
    </form>
  )
}

function Settings({ path }: { path: string }) {
  const board = useStore(s => s.boards[path])
  const [meta, setMeta] = useState<BoardMeta | undefined>(board?.meta)
  const [repoInherited] = useState(board?.codeRepo && !board.meta.codeRepo ? board.codeRepo : undefined)
  const savedLocal = useStore(s => s.config?.codeRepos?.[path] ?? '')
  const [localRepo, setLocalRepo] = useState(savedLocal)
  if (!board || !meta) return <p>Loading…</p>
  const counts = new Map<string, number>()
  for (const card of board.cards) if (card.list && !card.archived) counts.set(card.list, (counts.get(card.list) ?? 0) + 1)

  const setList = (index: number, list: ListDef | null) => {
    const lists = [...meta.lists]
    if (list) lists[index] = list
    else lists.splice(index, 1)
    setMeta({ ...meta, lists })
  }
  const moveList = (index: number, by: number) => {
    const lists = [...meta.lists]
    const [item] = lists.splice(index, 1)
    lists.splice(Math.max(0, Math.min(lists.length, index + by)), 0, item)
    setMeta({ ...meta, lists })
  }
  const addList = () => {
    let id = 'new-list'
    for (let n = 2; meta.lists.some(l => l.id === id); n++) id = `new-list-${n}`
    setMeta({ ...meta, lists: [...meta.lists, { id, title: 'New list' }] })
  }
  const save = async () => {
    // A list added here gets its id from its title as saved; existing ids never change.
    const known = new Set(board.meta.lists.map(l => l.id))
    const lists: ListDef[] = []
    for (const list of meta.lists) {
      let id = list.id
      if (!known.has(id)) {
        const base = slugify(list.title)
        id = base
        for (let n = 2; lists.some(l => l.id === id) || known.has(id); n++) id = `${base}-${n}`
      }
      lists.push({ id, title: list.title.trim() || id, ...(list.archived ? { archived: true } : {}) })
    }
    try {
      if (localRepo.trim() !== savedLocal) {
        await api.config.setCodeRepo(path, localRepo.trim() || null)
        useStore.setState({ config: await api.config.get() })
      }
      await api.boards.updateMeta(path, {
        title: meta.title,
        lists,
        codeRepo: meta.codeRepo || undefined,
        flow: meta.flow?.doing || meta.flow?.done ? meta.flow : undefined,
        promptNotes: meta.promptNotes || undefined,
      })
      await actions.loadBoard(path)
      await actions.refreshTree()
      actions.setModal(null)
    } catch (error) {
      actions.toast((error as Error).message, 'error')
    }
  }

  return (
    <div className="settings">
      <h2>
        Board settings <span className="board-key">{meta.key}</span>
      </h2>
      <label className="field">
        <span>Title</span>
        <input value={meta.title} onChange={e => setMeta({ ...meta, title: e.target.value })} />
      </label>
      <label className="field">
        <span>Code repo</span>
        <input
          value={meta.codeRepo ?? ''}
          placeholder={repoInherited ? `${repoInherited} (inherited)` : '/path/to/the/repo the cards are about'}
          onChange={e => setMeta({ ...meta, codeRepo: e.target.value })}
        />
        <small className="muted">
          Shared through the repo; may be relative to the board repo (<code>../godot-shooter</code>). Tackled sessions start
          there, and its commits with Card: trailers show on the cards.
        </small>
      </label>
      <label className="field">
        <span>Code repo on this machine</span>
        <div className="input-row">
          <input
            value={localRepo}
            placeholder="(use the shared path above)"
            onChange={e => setLocalRepo(e.target.value)}
          />
          <button
            type="button"
            className="small"
            onClick={async () => {
              const picked = await api.config.pickFolder('The code repo on this machine')
              if (picked) setLocalRepo(picked)
            }}
          >
            Browse…
          </button>
        </div>
        <small className="muted">
          This computer only, never synced: for a repo that sits at another path on your other machine. Child boards
          inherit it. Now: <code>{board.codeRepo ?? 'none'}</code>
        </small>
      </label>
      <div className="field-grid">
        <label className="field">
          <span>Tackling moves cards to</span>
          <select
            value={meta.flow?.doing ?? ''}
            onChange={e => setMeta({ ...meta, flow: { ...meta.flow, doing: e.target.value || undefined } })}
          >
            <option value="">(leave them where they are)</option>
            {meta.lists.map(l => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Claude moves finished cards to</span>
          <select
            value={meta.flow?.done ?? ''}
            onChange={e => setMeta({ ...meta, flow: { ...meta.flow, done: e.target.value || undefined } })}
          >
            <option value="">(nowhere: I move them)</option>
            {meta.lists.map(l => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Prompt notes</span>
        <textarea
          rows={3}
          value={meta.promptNotes ?? ''}
          placeholder="Appended to every tackle prompt, e.g. “Hand each self-contained card to the opus-xhigh agent.”"
          onChange={e => setMeta({ ...meta, promptNotes: e.target.value })}
        />
      </label>
      <div className="field">
        <span>Lists</span>
        <ul className="list-editor">
          {meta.lists.map((list, i) => (
            <li key={list.id} className={list.archived ? 'archived' : ''}>
              <input
                value={list.title}
                onChange={e => setList(i, { ...list, title: e.target.value })}
                aria-label={`List ${i + 1} title`}
              />
              {list.archived ? (
                <button className="small" onClick={() => setList(i, { ...list, archived: undefined })}>
                  Restore
                </button>
              ) : (
                <span className="muted mono small" title="The id cards store; fixed once created">
                  {list.id}
                </span>
              )}
              <span className="muted small">{counts.get(list.id) ?? 0}</span>
              <button className="icon-button small" disabled={i === 0} onClick={() => moveList(i, -1)} aria-label="Move up">
                ↑
              </button>
              <button
                className="icon-button small"
                disabled={i === meta.lists.length - 1}
                onClick={() => moveList(i, 1)}
                aria-label="Move down"
              >
                ↓
              </button>
              <button
                className="icon-button small"
                disabled={(counts.get(list.id) ?? 0) > 0}
                title={(counts.get(list.id) ?? 0) > 0 ? 'Move its cards out first' : 'Remove list'}
                onClick={() => setList(i, null)}
                aria-label="Remove list"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <button className="ghost small" onClick={addList}>
          + Add list
        </button>
      </div>
      <div className="modal-actions">
        <button className="ghost" onClick={() => actions.setModal(null)}>
          Cancel
        </button>
        <button className="accent" onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  )
}


function AddProject() {
  const [root, setRoot] = useState('')
  const [name, setName] = useState('')
  const [codeRepo, setCodeRepo] = useState('')
  const [busy, setBusy] = useState(false)
  const pick = async (title: string, set: (v: string) => void, also?: (v: string) => void) => {
    const folder = await api.projects.pickFolder(title)
    if (folder) {
      set(folder)
      also?.(folder)
    }
  }
  const add = async () => {
    if (!root.trim()) return
    setBusy(true)
    try {
      const id = await actions.addProject({ boardRoot: root.trim(), name: name.trim() || undefined, codeRepo: codeRepo.trim() || undefined })
      actions.setModal(null)
      actions.toast(`Added ${name.trim() || id}`)
    } catch (error) {
      actions.toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        void add()
      }}
    >
      <h2>Add project</h2>
      <p className="muted small">
        A project is one board repo. Pick an existing one (a clone of it on this machine), or an empty or new folder:
        it becomes a git repo for a fresh set of boards.
      </p>
      <label className="field">
        <span>Board repo folder</span>
        <div className="input-row">
          <input autoFocus value={root} placeholder="/path/to/my-board" onChange={e => setRoot(e.target.value)} />
          <button
            type="button"
            className="small"
            onClick={() =>
              void pick('The board repo', setRoot, v => !name && setName(v.split(/[\\/]/).filter(Boolean).at(-1) ?? ''))
            }
          >
            Browse…
          </button>
        </div>
      </label>
      <label className="field">
        <span>Name</span>
        <input value={name} placeholder="(the folder's name)" onChange={e => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Code folder on this machine</span>
        <div className="input-row">
          <input value={codeRepo} placeholder="/path/to/the/code (optional)" onChange={e => setCodeRepo(e.target.value)} />
          <button type="button" className="small" onClick={() => void pick('The code folder', setCodeRepo)}>
            Browse…
          </button>
        </div>
        <small className="muted">
          Where its boards' Claude sessions start and their commits are read, unless a board names its own. Kept on
          this machine only.
        </small>
      </label>
      <div className="modal-actions">
        <button type="button" className="ghost" onClick={() => actions.setModal(null)}>
          Cancel
        </button>
        <button type="submit" className="accent" disabled={!root.trim() || busy}>
          Add project
        </button>
      </div>
    </form>
  )
}

function ProjectSettings({ id }: { id: string }) {
  const project = useStore(s => s.projects.find(p => p.id === id))
  const [name, setName] = useState(project?.name ?? '')
  const [codeRepo, setCodeRepo] = useState(project?.codeRepo ?? '')
  if (!project) return <p>That project is gone.</p>
  const save = async () => {
    try {
      await api.projects.update(id, { name, codeRepo: codeRepo.trim() || null })
      await actions.refreshTree()
      for (const key of Object.keys(useStore.getState().boards)) if (key.startsWith(`${id}:`)) await actions.loadBoard(key)
      actions.setModal(null)
    } catch (error) {
      actions.toast((error as Error).message, 'error')
    }
  }
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        void save()
      }}
    >
      <h2>Project settings</h2>
      <label className="field">
        <span>Name</span>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} />
      </label>
      <div className="field">
        <span>Board repo</span>
        <code className="path">{project.root}</code>
      </div>
      <label className="field">
        <span>Code folder on this machine</span>
        <div className="input-row">
          <input value={codeRepo} placeholder="(none)" onChange={e => setCodeRepo(e.target.value)} />
          <button
            type="button"
            className="small"
            onClick={async () => {
              const folder = await api.projects.pickFolder('The code folder')
              if (folder) setCodeRepo(folder)
            }}
          >
            Browse…
          </button>
        </div>
        <small className="muted">
          Every board of the project uses it unless the board names a code repo of its own that exists here (board
          settings).
        </small>
      </label>
      <div className="modal-actions">
        <button type="button" className="ghost" onClick={() => actions.setModal(null)}>
          Cancel
        </button>
        <button type="submit" className="accent">
          Save
        </button>
      </div>
    </form>
  )
}

/** A board with cards goes only once its name has been typed: it takes its child boards with it. */
function DeleteBoard({ path }: { path: string }) {
  const node = useStore(s => findNode(s.tree, path))
  const [typed, setTyped] = useState('')
  if (!node) return <p>That board is gone.</p>
  const count = (n: typeof node): { cards: number; boards: number } =>
    n.children.reduce(
      (acc, child) => {
        const c = count(child)
        return { cards: acc.cards + c.cards, boards: acc.boards + 1 + c.boards }
      },
      { cards: n.cardCount, boards: 0 },
    )
  const { cards, boards } = count(node)
  const remove = async () => {
    try {
      await api.boards.remove(path, true)
      actions.closeTab(path)
      actions.setModal(null)
      actions.toast(`Deleted ${node.title}`)
    } catch (error) {
      actions.toast((error as Error).message, 'error')
    }
  }
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        if (typed === node.title) void remove()
      }}
    >
      <h2>Delete “{node.title}”?</h2>
      <p>
        Its {cards} card{cards === 1 ? '' : 's'}
        {boards ? ` and ${boards} child board${boards === 1 ? '' : 's'}` : ''} leave the board repo. They stay in its git
        history, so a <code>git revert</code> of the commit brings them back.
      </p>
      <label className="field">
        <span>Type the board's name to confirm</span>
        <input autoFocus value={typed} placeholder={node.title} onChange={e => setTyped(e.target.value)} />
      </label>
      <div className="modal-actions">
        <button type="button" className="ghost" onClick={() => actions.setModal(null)}>
          Cancel
        </button>
        <button type="submit" className="accent danger-fill" disabled={typed !== node.title}>
          Delete board
        </button>
      </div>
    </form>
  )
}
