// Browsing, read-only: your board repos, a repo's boards, a board's lists one at a time (tabs
// along the top, which read better on a phone than columns scrolled sideways), and a card. Where
// you were is remembered, so the app reopens there, drawn from the cache at once and refreshed
// behind it. Android's back button goes up a level. Signed out, the cache is all there is, and a
// bar offers to sign in again.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { App as CapApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { isDivider, listColorAt } from '@shared/cardfile'
import { boardColumns, UNLISTED } from '@shared/selection'
import type { Card, ListDef } from '@shared/types'
import { installUrl } from '../github/config'
import { reach, type Reach } from '../github/installations'
import { SignedOut, type Session } from '../github/session'
import type { RepoCache, Snapshot } from '../repo/cache'
import { boardTree, type BoardNode } from '../repo/layout'
import { boardMetas, openBoard, refresh, type Board } from '../repo/reader'

export type Place = { repo?: string; board?: string; list?: string; card?: string }

const PLACE = 'corkboard:place'
const REACH = 'corkboard:reach'

export function lastPlace(): Place {
  try {
    return JSON.parse(localStorage.getItem(PLACE) ?? '{}') as Place
  } catch {
    return {}
  }
}

type Props = {
  session: Session
  cache: RepoCache
  /** Why you're signed out, when you are: the cache is then all there is. */
  signedOut?: string
  onSignIn: () => void
  onSignOut: () => Promise<void>
}

export function Browse({ session, cache, signedOut, onSignIn, onSignOut }: Props) {
  const [place, setPlace] = useState<Place>(lastPlace)
  const api = useMemo(() => (signedOut ? undefined : session.api.bind(session)), [session, signedOut])

  const go = useCallback((next: Place) => {
    setPlace(next)
    localStorage.setItem(PLACE, JSON.stringify(next))
  }, [])

  const up = useCallback(
    (p: Place): Place | undefined =>
      p.card ? { ...p, card: undefined } : p.board ? { repo: p.repo } : p.repo ? {} : undefined,
    [],
  )

  // Android's back button: up a level, and out of the app from the top.
  const placeRef = useRef(place)
  placeRef.current = place
  useEffect(() => {
    const handle = CapApp.addListener('backButton', () => {
      const next = up(placeRef.current)
      if (next) go(next)
      else void CapApp.exitApp()
    })
    return () => void handle.then(h => h.remove())
  }, [go, up])

  const repo = useSnapshot(api, cache, place.repo)
  const board = useBoard(api, cache, repo.snapshot, place.board)

  const bar = signedOut && (
    <div className="bar">
      <span>{signedOut} Showing what was last read.</span>
      <button type="button" onClick={onSignIn}>
        Sign in
      </button>
    </div>
  )

  let screen: ReactNode
  if (!place.repo) {
    screen = <Repos api={api} onPick={r => go({ repo: r })} onSignOut={onSignOut} />
  } else if (!place.board) {
    screen = (
      <Boards
        repo={place.repo}
        state={repo}
        tree={repo.snapshot ? boardTree(boardMetas(cache, repo.snapshot)) : []}
        onBack={() => go({})}
        onPick={b => go({ repo: place.repo, board: b })}
      />
    )
  } else if (!place.card) {
    screen = (
      <BoardView
        title={board.board?.meta.title ?? place.board}
        state={repo}
        board={board.board}
        loading={board.loading}
        list={place.list}
        onBack={() => go({ repo: place.repo })}
        onList={l => go({ ...place, list: l })}
        onCard={c => go({ ...place, card: c })}
        onRefresh={repo.refresh}
      />
    )
  } else {
    const card = board.board?.cards.find(c => c.id === place.card)
    screen = <CardView card={card} id={place.card} onBack={() => go({ ...place, card: undefined })} />
  }

  return (
    <div className="browse">
      {bar}
      {screen}
    </div>
  )
}

type RepoState = { snapshot?: Snapshot; busy: boolean; error?: string; refresh: () => Promise<void> }

/** A repo's snapshot: the cached one at once, then a fresh one when signed in. */
function useSnapshot(api: Session['api'] | undefined, cache: RepoCache, repo: string | undefined): RepoState {
  const [snapshot, setSnapshot] = useState(() => (repo ? cache.snapshot(repo) : undefined))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const reload = useCallback(async () => {
    if (!repo || !api) return
    setBusy(true)
    setError(undefined)
    try {
      setSnapshot(await refresh(api, cache, repo))
    } catch (e) {
      if (!(e instanceof SignedOut)) setError(`Couldn't refresh: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [api, cache, repo])

  useEffect(() => {
    setSnapshot(repo ? cache.snapshot(repo) : undefined)
    void reload()
    // Back from another app: the desktop may have pushed meanwhile.
    const handle = CapApp.addListener('resume', () => void reload())
    return () => void handle.then(h => h.remove())
  }, [cache, repo, reload])

  return { snapshot, busy, error, refresh: reload }
}

/** A board: what the cache holds at once, then the cards it lacked once read. */
function useBoard(api: Session['api'] | undefined, cache: RepoCache, snapshot: Snapshot | undefined, path: string | undefined) {
  const [board, setBoard] = useState<Board>()
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!snapshot || !path) return setBoard(undefined)
    let live = true
    void openBoard(undefined, cache, snapshot, path).then(b => live && setBoard(b))
    if (api) {
      setLoading(true)
      openBoard(api, cache, snapshot, path)
        .then(b => live && setBoard(b))
        .catch(() => {})
        .finally(() => live && setLoading(false))
    }
    return () => {
      live = false
    }
  }, [api, cache, snapshot, path])
  return { board, loading }
}

function Header({ title, sub, onBack, busy }: { title: string; sub?: string; onBack?: () => void; busy?: boolean }) {
  return (
    <header className="header">
      {onBack && (
        <button className="back" type="button" onClick={onBack} aria-label="Back">
          ‹
        </button>
      )}
      <div className="titles">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {busy && <span className="spinner" aria-label="Refreshing" />}
    </header>
  )
}

/** A scrolling page that refreshes when pulled down from its top. */
function Pull({ onRefresh, children }: { onRefresh?: () => Promise<void>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const start = useRef<number | undefined>(undefined)
  const [pulled, setPulled] = useState(0)
  const THRESHOLD = 70
  return (
    <div
      ref={ref}
      className="page"
      onTouchStart={e => {
        start.current = onRefresh && ref.current?.scrollTop === 0 ? e.touches[0].clientY : undefined
      }}
      onTouchMove={e => {
        if (start.current !== undefined) setPulled(Math.max(0, Math.min(120, e.touches[0].clientY - start.current)))
      }}
      onTouchEnd={() => {
        if (pulled >= THRESHOLD) void onRefresh?.()
        start.current = undefined
        setPulled(0)
      }}
    >
      {pulled > 0 && (
        <div className="pull" style={{ height: pulled }}>
          {pulled >= THRESHOLD ? 'Release to refresh' : 'Pull to refresh'}
        </div>
      )}
      {children}
    </div>
  )
}

function Repos({ api, onPick, onSignOut }: { api: Session['api'] | undefined; onPick: (repo: string) => void; onSignOut: () => Promise<void> }) {
  const [known, setKnown] = useState<Reach | undefined>(() => {
    try {
      return JSON.parse(localStorage.getItem(REACH) ?? 'null') ?? undefined
    } catch {
      return undefined
    }
  })
  const [error, setError] = useState<string>()

  const look = useCallback(async () => {
    if (!api) return
    try {
      const got = await reach(api)
      localStorage.setItem(REACH, JSON.stringify(got))
      setKnown(got)
      setError(undefined)
    } catch (e) {
      if (!(e instanceof SignedOut)) setError((e as Error).message)
    }
  }, [api])

  useEffect(() => {
    void look()
    // Back from the browser, after installing the app on more repos, say.
    const handle = CapApp.addListener('resume', () => void look())
    return () => void handle.then(h => h.remove())
  }, [look])

  if (known && !known.repos.length) {
    return (
      <main className="centred">
        <h1>One more step</h1>
        <p>
          Signed in as {known.login}, but the Corkboard app isn't installed on any of your repos yet. Install it on your
          board repos only: it can't reach the rest.
        </p>
        <button className="primary" type="button" onClick={() => Browser.open({ url: installUrl() })}>
          Install on GitHub
        </button>
        <button className="plain" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </main>
    )
  }
  return (
    <>
      <Header title="Board repos" sub={known ? `Signed in as ${known.login}` : undefined} />
      <Pull onRefresh={api ? look : undefined}>
        {error && <p className="note error">{error}</p>}
        {!known && !error && <p className="note">Looking at your GitHub account…</p>}
        <ul className="rows">
          {known?.repos.map(r => (
            <li key={r}>
              <button type="button" onClick={() => onPick(r)}>
                <span className="row-title">{r.split('/')[1]}</span>
                <span className="row-sub">{r.split('/')[0]}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="foot">
          <button className="plain" type="button" onClick={() => Browser.open({ url: installUrl() })}>
            Add or remove repos on GitHub
          </button>
          {api && (
            <button className="plain" type="button" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
      </Pull>
    </>
  )
}

function Boards(props: { repo: string; state: RepoState; tree: BoardNode[]; onBack: () => void; onPick: (path: string) => void }) {
  const { repo, state, tree, onBack, onPick } = props
  const rows: ReactNode[] = []
  const walk = (nodes: BoardNode[], depth: number) => {
    for (const node of nodes) {
      rows.push(
        <li key={node.path}>
          <button type="button" style={{ paddingLeft: 16 + depth * 20 }} onClick={() => onPick(node.path)}>
            <span className="row-title">{node.title || node.path}</span>
            <span className="row-sub">{node.key}</span>
          </button>
        </li>,
      )
      walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)
  return (
    <>
      <Header title={repo.split('/')[1]} sub="Boards" onBack={onBack} busy={state.busy} />
      <Pull onRefresh={state.refresh}>
        {state.error && <p className="note error">{state.error}</p>}
        {state.snapshot?.truncated && <p className="note">GitHub cut this repo's file list short: some boards may be missing.</p>}
        {!state.snapshot && !state.error && <p className="note">Reading the repo…</p>}
        {state.snapshot && !rows.length && <p className="note">No boards in this repo.</p>}
        <ul className="rows">{rows}</ul>
      </Pull>
    </>
  )
}

function BoardView(props: {
  title: string
  state: RepoState
  board?: Board
  loading: boolean
  list?: string
  onBack: () => void
  onList: (list: string) => void
  onCard: (id: string) => void
  onRefresh: () => Promise<void>
}) {
  const { title, state, board, loading, onBack, onList, onCard, onRefresh } = props
  const columns = useMemo(() => (board ? boardColumns(board, () => true) : undefined), [board])
  const byId = useMemo(() => new Map(board?.cards.map(c => [c.id, c])), [board])
  const lists: (ListDef & { color: string })[] = board
    ? board.meta.lists.flatMap((l, i) => (l.archived ? [] : [{ ...l, color: listColorAt(board.meta.lists, i) }]))
    : []
  if (columns?.[UNLISTED].length) lists.unshift({ id: UNLISTED, title: 'Ideas', color: 'var(--idea)' })
  const current = lists.find(l => l.id === props.list) ?? lists[0]
  const cards = (current && columns?.[current.id]?.map(id => byId.get(id)).filter((c): c is Card => !!c)) ?? []

  return (
    <>
      <Header title={title} sub={current ? `${cards.filter(c => !isDivider(c)).length} cards` : undefined} onBack={onBack} busy={state.busy || loading} />
      <nav className="tabs">
        {lists.map(l => (
          <button
            key={l.id}
            type="button"
            className={l.id === current?.id ? 'tab active' : 'tab'}
            style={{ borderBottomColor: l.id === current?.id ? l.color : 'transparent' }}
            onClick={() => onList(l.id)}
          >
            <span className="dot" style={{ background: l.color }} />
            {l.title}
          </button>
        ))}
      </nav>
      <Pull onRefresh={onRefresh}>
        {state.error && <p className="note error">{state.error}</p>}
        {!board && <p className="note">{loading ? 'Reading the cards…' : 'This board isn’t saved on the phone yet.'}</p>}
        {!!board?.missing && <p className="note">{board.missing} cards aren’t saved on the phone yet.</p>}
        {board && current && !cards.length && <p className="note">No cards.</p>}
        <ul className="cards">
          {cards.map(card =>
            isDivider(card) ? (
              <li key={card.id} className="divider" />
            ) : (
              <li key={card.id}>
                <button type="button" className="card" onClick={() => onCard(card.id)}>
                  <span className="card-title">{card.title}</span>
                  <span className="card-meta">
                    <span className="card-id">{card.id}</span>
                    {card.complete && <span className="chip done">Done</span>}
                    {card.due && <span className="chip">{formatDue(card.due)}</span>}
                    {card.labels.map(l => (
                      <span key={l} className="chip">
                        {l}
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            ),
          )}
        </ul>
      </Pull>
    </>
  )
}

const markdownParts: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={e => {
        e.preventDefault()
        if (href && /^https?:/.test(href)) void Browser.open({ url: href })
      }}
    >
      {children}
    </a>
  ),
  // Images in descriptions are the board repo's own files, which the phone doesn't read yet.
  img: ({ alt }) => <span className="img-alt">[image{alt ? `: ${alt}` : ''}]</span>,
}

function CardView({ card, id, onBack }: { card?: Card; id: string; onBack: () => void }) {
  return (
    <>
      <Header title={id} onBack={onBack} />
      <div className="page card-page">
        {!card ? (
          <p className="note">This card isn’t on the board any more.</p>
        ) : (
          <>
            <h2>{card.title}</h2>
            <p className="card-meta">
              {card.complete && <span className="chip done">Done</span>}
              {card.due && <span className="chip">Due {formatDue(card.due)}</span>}
              {card.labels.map(l => (
                <span key={l} className="chip">
                  {l}
                </span>
              ))}
            </p>
            <div className="markdown">
              {card.body.trim() ? (
                <Markdown remarkPlugins={[remarkGfm]} components={markdownParts}>
                  {card.body}
                </Markdown>
              ) : (
                <p className="note">No description.</p>
              )}
            </div>
          </>
        )}
      </div>
    </>
  )
}

function formatDue(due: string): string {
  const date = new Date(due)
  return Number.isNaN(date.getTime()) ? due : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
