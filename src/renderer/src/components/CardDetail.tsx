import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Card, CodeCommit, LoadedBoard, SessionRef } from '@shared/types'
import { discussCards, tackleCards } from '../tackle'
import { actions, api, commitsFor, listColor, localTime, useStore } from '../state'

type IndexEntry = { id: string; title: string; boardPath: string; boardTitle: string }

export function CardDetail() {
  const open = useStore(s => s.openCard)
  const activeTab = useStore(s => s.activeTab)
  const board = useStore(s => (s.openCard ? s.boards[s.openCard.boardPath] : undefined))
  const card = board?.cards.find(c => c.id === open?.id)
  // The drawer belongs to the board in front; switching tabs hides it.
  if (!open || !board || !card || open.boardPath !== activeTab) return null
  return (
    <>
      <ResizeHandle />
      <Drawer key={`${board.path}:${card.id}`} board={board} card={card} />
    </>
  )
}

/** The drawer's left edge. A sibling of the drawer, so it stays put while the drawer scrolls. */
function ResizeHandle() {
  return (
    <div
      className="drawer-resize"
      onPointerDown={e => {
        e.preventDefault()
        const startX = e.clientX
        const start = useStore.getState().drawerWidth
        // Leave the board in front at least a column's width.
        const max = Math.max(320, e.currentTarget.parentElement!.clientWidth - 280)
        const move = (ev: PointerEvent) =>
          useStore.setState({ drawerWidth: Math.round(Math.min(max, Math.max(320, start - (ev.clientX - startX)))) })
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          document.body.classList.remove('resizing-x')
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        document.body.classList.add('resizing-x')
      }}
      onDoubleClick={() => useStore.setState({ drawerWidth: 440 })}
      title="Drag to resize; double-click for the default width"
    />
  )
}

function Drawer({ board, card }: { board: LoadedBoard; card: Card }) {
  const allCommits = useStore(s => s.commits[board.path])
  const desktop = useStore(s => s.desktop)
  const width = useStore(s => s.drawerWidth)
  const commits = useMemo(() => commitsFor(allCommits, card.id), [allCommits, card.id])
  const [title, setTitle] = useState(card.title)
  const [body, setBody] = useState(card.body)
  const [editing, setEditing] = useState(!card.body.trim())
  const [index, setIndex] = useState<IndexEntry[]>([])

  // A Claude session edits the file under us: follow it unless a field is being typed in.
  useEffect(() => {
    if (document.activeElement?.getAttribute('data-field') !== 'title') setTitle(card.title)
  }, [card.title])
  useEffect(() => {
    if (document.activeElement?.getAttribute('data-field') !== 'body') setBody(card.body)
  }, [card.body])
  useEffect(() => {
    void api.boards.index().then(setIndex)
  }, [card.links.length])

  const save = (patch: Partial<Card>) => void actions.updateCard(board.path, card.id, patch)
  const titleOf = (id: string) => index.find(e => e.id === id)

  return (
    <aside className="drawer" aria-label={`Card ${card.id}`} style={{ width }}>
      <div className="drawer-top">
        <div className="drawer-head">
          <span className="card-id big">{card.id}</span>
          <span className="muted">{board.meta.title}</span>
          <span className="spacer" />
          <button className="icon-button" aria-label="Close" onClick={() => actions.closeCard()}>
            ×
          </button>
        </div>

        <textarea
          className="title-input"
          data-field="title"
          rows={2}
          value={title}
          onChange={e => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== card.title && save({ title: title.trim() })}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLTextAreaElement).blur()
            }
          }}
        />
      </div>

      <div className="drawer-body">
        <div className="field-row">
          <label>List</label>
          <select
            value={card.list ?? ''}
            style={{ borderLeftColor: listColor(board, card.list) }}
            onChange={e => save({ list: e.target.value || null })}
          >
            <option value="">Map only (idea)</option>
            {board.meta.lists.map(l => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={!!card.complete} onChange={e => save({ complete: e.target.checked || undefined })} />
            Complete
          </label>
        </div>

        <div className="tackle-row">
          {desktop && (
            <button className="accent" title="A new Code session in the Claude desktop app" onClick={() => void tackleCards(board.path, [card.id], 'desktop')}>
              Claude desktop
            </button>
          )}
          <button
            className={desktop ? '' : 'accent'}
            title="A Claude Code session in the terminal panel"
            onClick={() => void tackleCards(board.path, [card.id], 'local')}
          >
            Terminal
          </button>
          <button title="A terminal session in its own git worktree" onClick={() => void tackleCards(board.path, [card.id], 'local-worktree')}>
            Worktree
          </button>
          <button title="A claude.ai/code session on the pushed branch" onClick={() => void tackleCards(board.path, [card.id], 'cloud')}>
            Cloud
          </button>
          <span className="spacer" />
          <button
            className="ghost"
            title={`Talk the card through ${desktop ? 'in Claude desktop' : 'in a terminal'}: questions, scope, details for the card; nothing is implemented unless you ask`}
            onClick={() => void discussCards(board.path, [card.id], desktop ? 'desktop' : 'local')}
          >
            Discuss
          </button>
        </div>

        <section>
          <div className="section-head">
            <h3>Description</h3>
            <button className="link" onClick={() => setEditing(e => !e)}>
              {editing ? 'Preview' : 'Edit'}
            </button>
          </div>
          {editing ? (
            <textarea
              className="body-input"
              data-field="body"
              value={body}
              placeholder="Markdown"
              rows={Math.min(24, Math.max(6, body.split('\n').length + 1))}
              onChange={e => setBody(e.target.value)}
              onBlur={() => body !== card.body && save({ body })}
            />
          ) : (
            <div className="markdown" onDoubleClick={() => setEditing(true)}>
              {card.body.trim() ? (
                <Markdown remarkPlugins={[remarkGfm]}>{card.body}</Markdown>
              ) : (
                <p className="muted">No description.</p>
              )}
            </div>
          )}
        </section>

        <section>
          <h3>Linked cards</h3>
          <div className="links">
            {card.links.map(id => {
              const entry = titleOf(id)
              return (
                <span key={id} className="link-chip">
                  <button className="link" onClick={() => void openLinked(id, entry)}>
                    {id}
                  </button>
                  <span className="link-title">{entry?.title ?? 'not found'}</span>
                  <button
                    className="icon-button small"
                    aria-label={`Unlink ${id}`}
                    onClick={() => save({ links: card.links.filter(l => l !== id) })}
                  >
                    ×
                  </button>
                </span>
              )
            })}
          </div>
          <LinkPicker
            index={index.filter(e => e.id !== card.id && !card.links.includes(e.id))}
            onPick={id => save({ links: [...card.links, id] })}
          />
        </section>

        <section>
          <h3>Commits</h3>
          {commits.length ? (
            <ul className="commits">
              {commits.map(c => (
                <CommitRow key={c.sha} boardPath={board.path} commit={c} />
              ))}
            </ul>
          ) : (
            <p className="muted small">
              None yet. Commits whose message has a <code>Card: {card.id}</code> line show up here.
            </p>
          )}
        </section>

        {card.sessions.length > 0 && (
          <section>
            <div className="section-head">
              <h3>Claude sessions</h3>
              {card.sessions.length > 1 && (
                <button
                  className="link"
                  title="Take every session off this card; the conversations themselves stay in Claude Code"
                  onClick={() => save({ sessions: [] })}
                >
                  Forget all
                </button>
              )}
            </div>
            <ul className="sessions">
              {card.sessions
                .map((s, index) => ({ s, index }))
                .reverse()
                .map(({ s, index }) => (
                  <SessionRow
                    key={`${s.started}-${index}`}
                    boardPath={board.path}
                    session={s}
                    onForget={() => save({ sessions: card.sessions.filter((_, i) => i !== index) })}
                  />
                ))}
            </ul>
          </section>
        )}

        <div className="drawer-foot">
          <button
            className="ghost"
            onClick={async () => api.shell.openPath(await api.cards.filePath(board.path, card.id))}
          >
            Open file
          </button>
          {card.trello && (
            <button className="ghost" onClick={() => api.shell.openExternal(card.trello!)}>
              Trello
            </button>
          )}
          <span className="spacer" />
          <button className="ghost danger" onClick={() => save({ archived: card.archived ? undefined : true })}>
            {card.archived ? 'Unarchive' : 'Archive'}
          </button>
        </div>
        <p className="muted tiny">
          Created {localTime(card.created, false)}
          {card.updated ? ` · updated ${localTime(card.updated)}` : ''}
        </p>
      </div>
    </aside>
  )
}

async function openLinked(id: string, entry?: IndexEntry) {
  if (!entry) return
  await actions.openBoard(entry.boardPath)
  actions.openCard(entry.boardPath, id)
}

function LinkPicker({ index, onPick }: { index: IndexEntry[]; onPick: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const focusLinks = useStore(s => s.focusLinks)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusLinks) {
      input.current?.scrollIntoView({ block: 'center' })
      input.current?.focus()
    }
  }, [focusLinks])
  const q = query.trim().toLowerCase()
  const hits = q
    ? index.filter(e => e.id.toLowerCase().includes(q) || e.title.toLowerCase().includes(q)).slice(0, 8)
    : []
  return (
    <div className="link-picker">
      <input
        ref={input}
        type="search"
        placeholder="Link a card on any board: id or title"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && hits[0]) {
            onPick(hits[0].id)
            setQuery('')
          }
        }}
      />
      {hits.length > 0 && (
        <ul className="picker-list">
          {hits.map(h => (
            <li key={h.id}>
              <button
                onClick={() => {
                  onPick(h.id)
                  setQuery('')
                }}
              >
                <span className="mono">{h.id}</span> {h.title}
                <span className="muted"> · {h.boardTitle}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CommitRow({ boardPath, commit }: { boardPath: string; commit: CodeCommit }) {
  const [files, setFiles] = useState<{ status: string; file: string }[] | null>(null)
  return (
    <li>
      <button
        className="commit-line"
        onClick={async () => setFiles(files ? null : await api.git.commitFiles(boardPath, commit.sha))}
      >
        <span className="mono sha">{commit.short}</span>
        <span className="subject">{commit.subject}</span>
        <span className="muted">{localTime(commit.date, false)}</span>
      </button>
      {files && (
        <ul className="files">
          {files.map(f => (
            <li key={f.file} className="mono">
              <span className={`status s-${f.status[0]}`}>{f.status[0]}</span> {f.file}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function SessionRow({
  boardPath,
  session,
  onForget,
}: {
  boardPath: string
  session: SessionRef
  onForget: () => void
}) {
  const desktop = useStore(s => s.desktop)
  const kind =
    session.kind === 'cloud'
      ? 'Cloud'
      : session.kind === 'desktop'
        ? 'Desktop'
        : session.kind === 'local-worktree'
          ? 'Worktree'
          : 'Terminal'
  const fail = (e: unknown) => actions.toast((e as Error).message, 'error')
  const others = (session.cards ?? []).length > 1 ? ` · with ${session.cards!.length - 1} more` : ''
  const detail = [session.name, session.id && `session ${session.id}`, session.cwd].filter(Boolean).join('\n')
  return (
    <li className="session" title={detail || undefined}>
      {session.purpose === 'discuss' && <span className="kind k-discuss">Discuss</span>}
      <span className={`kind k-${session.kind}`}>{kind}</span>
      <span className="muted">{localTime(session.started)}</span>
      <span className="muted">{others}</span>
      <span className="spacer" />
      {session.url && (
        <button className="link" onClick={() => api.shell.openExternal(session.url!)}>
          Open
        </button>
      )}
      {session.kind === 'desktop' ? (
        session.desktopId || session.id ? (
          <button className="small" title="Open it in the Claude desktop app" onClick={() => void api.tackle.resume(boardPath, session).catch(fail)}>
            Open
          </button>
        ) : (
          <span className="muted small" title="The card links to it once its prompt has been sent in the desktop app">
            waiting
          </span>
        )
      ) : (
        <>
          {desktop && session.id && session.kind !== 'cloud' && (
            <button className="small" title="Open this session in the Claude desktop app" onClick={() => void api.tackle.openInDesktop(session).catch(fail)}>
              Desktop
            </button>
          )}
          {(session.id || session.url) && (
            <button className="small" title="Resume it in a terminal tab" onClick={() => void api.tackle.resume(boardPath, session).catch(fail)}>
              Resume
            </button>
          )}
        </>
      )}
      <button
        className="icon-button small"
        aria-label="Forget this session"
        title="Take it off this card (the conversation itself stays in Claude Code)"
        onClick={onForget}
      >
        ×
      </button>
    </li>
  )
}
