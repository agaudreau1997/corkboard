// Browsing: your board repos, a repo's boards, a board's lists, and a card; and a "+" to jot a card
// down on the open list. This file holds where you are and the data the screens draw: where you
// were is remembered, so the app reopens there, drawn from the cache at once and refreshed behind
// it. A repo's screens are painted in its colours (`theme.json`), the repo list in the app's own.
// Android's back button goes up a level. Signed out, the cache is all there is, and a bar
// offers to sign in again. A new card waits in the outbox until it's sent.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { App as CapApp } from '@capacitor/app'
import { UNLISTED } from '@shared/selection'
import { SignedOut, type Session } from '../github/session'
import type { RepoCache, Snapshot } from '../repo/cache'
import { changeCard } from '../repo/editor'
import { boardTree } from '../repo/layout'
import type { Outbox } from '../repo/outbox'
import { boardMetas, openBoard, refresh, type Board } from '../repo/reader'
import type { Draft } from '../repo/writer'
import { paint } from '../theme'
import { Boards } from './Boards'
import { BoardView } from './BoardView'
import { CardView } from './CardView'
import { NewCard } from './NewCard'
import { ProjectMark } from './ProjectMark'
import { Repos } from './Repos'

export type Place = { repo?: string; board?: string; list?: string; card?: string; adding?: boolean }

const PLACE = 'corkboard:place'

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
  outbox: Outbox
  /** Why you're signed out, when you are: the cache is then all there is. */
  signedOut?: string
  onSignIn: () => void
  onSignOut: () => Promise<void>
}

export function Browse({ session, cache, outbox, signedOut, onSignIn, onSignOut }: Props) {
  const [place, setPlace] = useState<Place>(lastPlace)
  const api = useMemo(() => (signedOut ? undefined : session.api.bind(session)), [session, signedOut])

  const go = useCallback((next: Place) => {
    setPlace(next)
    localStorage.setItem(PLACE, JSON.stringify(next))
  }, [])

  const up = useCallback(
    (p: Place): Place | undefined =>
      p.adding ? { ...p, adding: undefined } : p.card ? { ...p, card: undefined } : p.board ? { repo: p.repo } : p.repo ? {} : undefined,
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
  const sending = useOutbox(api, cache, outbox, repo.refresh)

  // The open repo's look, kept by its last refresh (so read again whenever the snapshot changes).
  const look = place.repo && cache.look(place.repo)
  const theme = (look && look.theme) || undefined
  const themeKey = JSON.stringify(theme ?? null)
  useEffect(() => {
    paint(theme)
    // Back to the app's own colours when browsing ends (signed out to the sign-in screen).
    return () => paint()
  }, [themeKey])

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
    screen = <Repos api={api} cache={cache} onPick={r => go({ repo: r })} onSignOut={onSignOut} />
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
  } else if (place.adding) {
    const list = place.list ?? board.board?.meta.lists.find(l => !l.archived)?.id
    screen = (
      <NewCard
        listTitle={list === UNLISTED ? 'Ideas' : (board.board?.meta.lists.find(l => l.id === list)?.title ?? '')}
        onCancel={() => go({ ...place, adding: undefined })}
        onSave={(title, body) => {
          sending.add({
            key: crypto.randomUUID(),
            repo: place.repo!,
            board: place.board!,
            list: !list || list === UNLISTED ? null : list,
            title,
            body,
            created: new Date().toISOString(),
            uid: crypto.randomUUID(),
          })
          go({ ...place, list, adding: undefined })
        }}
      />
    )
  } else if (!place.card) {
    screen = (
      <BoardView
        title={board.board?.meta.title ?? place.board}
        mark={<ProjectMark look={look || undefined} />}
        state={repo}
        board={board.board}
        loading={board.loading}
        list={place.list}
        onBack={() => go({ repo: place.repo })}
        onList={l => go({ ...place, list: l })}
        onCard={c => go({ ...place, card: c })}
        onRefresh={async () => {
          await sending.send()
          await repo.refresh()
        }}
        drafts={sending.drafts.filter(d => d.repo === place.repo && d.board === place.board)}
        offline={!api}
        onAdd={() => go({ ...place, adding: true })}
        onDiscard={sending.discard}
      />
    )
  } else {
    const card = board.board?.cards.find(c => c.id === place.card)
    const b = board.board
    screen = (
      <CardView
        card={card}
        id={place.card}
        lists={b ? b.meta.lists.filter(l => !l.archived) : []}
        canChange={!!api && !!card && !!b?.shas[card.id]}
        onBack={() => go({ ...place, card: undefined })}
        onChange={async (change, overwrite) => {
          await changeCard(api!, cache, { repo: place.repo!, board: place.board! }, card!, b!.shas[card!.id], change, { overwrite })
          await repo.refresh()
          if (change.archived) go({ ...place, card: undefined })
        }}
      />
    )
  }

  return (
    <div className="browse">
      {bar}
      {screen}
    </div>
  )
}

/**
 * The outbox as the screens see it: its drafts, and a send when signed in, at start, when the app
 * comes back to the front, when the connection does, and right after a card is written.
 */
function useOutbox(api: Session['api'] | undefined, cache: RepoCache, outbox: Outbox, refreshRepo: () => Promise<void>) {
  const [drafts, setDrafts] = useState(() => outbox.drafts())
  const send = useCallback(async () => {
    if (!api || !outbox.drafts().length) return
    const sent = await outbox.send(api, cache)
    setDrafts(outbox.drafts())
    if (sent) await refreshRepo()
  }, [api, cache, outbox, refreshRepo])

  useEffect(() => {
    void send()
    const handle = CapApp.addListener('resume', () => void send())
    const online = () => void send()
    window.addEventListener('online', online)
    return () => {
      void handle.then(h => h.remove())
      window.removeEventListener('online', online)
    }
  }, [send])

  return {
    drafts,
    send,
    add(draft: Draft) {
      outbox.add(draft)
      setDrafts(outbox.drafts())
      void send()
    },
    discard(key: string) {
      outbox.discard(key)
      setDrafts(outbox.drafts())
    },
  }
}

export type RepoState = { snapshot?: Snapshot; busy: boolean; error?: string; refresh: () => Promise<void> }

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
