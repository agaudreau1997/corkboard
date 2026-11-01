// Browsing, laid out as the desktop is, folded for a phone: a board fills the screen, the side
// panel slides in over it from the left (the way between boards and repos), and a card opens in a
// drawer from the right, as does the form for a new one. A repo opens on its main board, picked
// by the desktop's rule (`mainBoardOf`). This file holds where you are (`Place`, src/place.ts) and
// the data the screens draw: the board you were on is remembered, so the app reopens there, drawn
// from the cache at once and refreshed behind it; a first run, with no board yet, opens on the
// panel. The window is painted in the open repo's colours (`theme.json`), the panel included, as
// the desktop paints its whole window in the project in front's. Android's back button closes the
// drawer, then the panel, then a board's settings, and then leaves the app. Signed out, the cache
// is all there is, and a bar offers to sign in again. A new card waits in the outbox until it's
// sent. A board's settings and lists change its board.json, which needs a connection.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { App as CapApp } from '@capacitor/app'
import { mainBoardOf } from '@shared/project'
import { UNLISTED } from '@shared/selection'
import { SignedOut, type Session } from '../github/session'
import { back, lastPlace, savePlace, startPlace, type Place } from '../place'
import type { RepoCache, Snapshot } from '../repo/cache'
import { changeBoard, type BoardChange } from '../repo/boardchange'
import { changeCard } from '../repo/editor'
import { boardTree } from '../repo/layout'
import { linkedCards } from '../repo/linked'
import type { Outbox } from '../repo/outbox'
import { boardMetas, openBoard, projectSettings, refresh, type Board } from '../repo/reader'
import type { Draft } from '../repo/writer'
import { paint } from '../theme'
import { BoardSettings } from './BoardSettings'
import { BoardView } from './BoardView'
import { Images } from './CardImage'
import { CardView } from './CardView'
import { NewCard } from './NewCard'
import { Panel } from './Panel'
import { Header, Pull } from './parts'
import { ProjectMark } from './ProjectMark'
import { Slide } from './Slide'

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
  const [place, setPlace] = useState<Place>(() => startPlace(lastPlace()))
  const api = useMemo(() => (signedOut ? undefined : session.api.bind(session)), [session, signedOut])

  const go = useCallback((next: Place) => {
    setPlace(next)
    savePlace(next)
  }, [])

  // Android's back button: the top layer closes, and from the board, out of the app.
  const placeRef = useRef(place)
  placeRef.current = place
  useEffect(() => {
    const handle = CapApp.addListener('backButton', () => {
      const next = back(placeRef.current)
      if (next) go(next)
      else void CapApp.exitApp()
    })
    return () => void handle.then(h => h.remove())
  }, [go])

  const repo = useSnapshot(api, cache, place.repo)
  const board = useBoard(api, cache, repo.snapshot, place.board)
  const sending = useOutbox(api, cache, outbox, repo.refresh)
  const boardChange = useBoardChange(api, cache, place, repo.refresh)

  // The open repo's look, kept by its last refresh (so read again whenever the snapshot changes).
  const look = place.repo && cache.look(place.repo)
  const theme = (look && look.theme) || undefined
  const themeKey = JSON.stringify(theme ?? null)
  useEffect(() => {
    paint(theme)
    // Back to the app's own colours when browsing ends (signed out to the sign-in screen).
    return () => paint()
  }, [themeKey])

  // The repo's boards as the desktop's side panel nests them, and the one it opens on.
  const snapshot = repo.snapshot?.repo === place.repo ? repo.snapshot : undefined
  const tree = useMemo(() => (snapshot ? boardTree(boardMetas(cache, snapshot)) : []), [cache, snapshot])
  const named = look ? look.settings.board : undefined
  const main = useMemo(() => mainBoardOf({ board: named }, tree), [named, tree])
  // A repo just picked opens on its main board once read; so does one whose open board went.
  useEffect(() => {
    if (!place.repo || !snapshot || !main) return
    if (place.board && snapshot.boards.some(b => b.path === place.board)) return
    go({ repo: place.repo, board: main, panel: place.panel })
  }, [go, main, place.board, place.repo, place.panel, snapshot])

  const bar = signedOut && (
    <div className="bar">
      <span>{signedOut} Showing what was last read.</span>
      <button type="button" onClick={onSignIn}>
        Sign in
      </button>
    </div>
  )

  const openPanel = () => go({ ...place, panel: true })
  const mark = <ProjectMark look={look || undefined} />
  let screen: ReactNode
  if (!place.repo) {
    screen = (
      <>
        <Header title="Corkboard" onMenu={openPanel} />
        <p className="note">Pick a board repo in the side panel.</p>
      </>
    )
  } else if (!place.board) {
    // Waiting for the repo's first read, to know its main board.
    screen = (
      <>
        <Header title={place.repo.split('/')[1]} mark={mark} onMenu={openPanel} busy={repo.busy} />
        <Pull onRefresh={repo.refresh}>
          {repo.error && <p className="note error">{repo.error}</p>}
          {!snapshot && !repo.error && <p className="note">{api ? 'Reading the repo…' : 'This repo isn’t saved on the phone yet.'}</p>}
          {snapshot && !tree.length && <p className="note">No boards in this repo.</p>}
        </Pull>
      </>
    )
  } else if (place.settings && board.board) {
    const counts = new Map<string, number>()
    for (const c of board.board.cards) if (c.list && !c.archived) counts.set(c.list, (counts.get(c.list) ?? 0) + 1)
    screen = (
      <BoardSettings
        meta={board.board.meta}
        counts={counts}
        canChange={!!api}
        busy={boardChange.busy || repo.busy}
        error={boardChange.error}
        onBack={() => go({ ...place, settings: undefined })}
        onChange={change => void boardChange.run(change)}
      />
    )
  } else {
    screen = (
      <BoardView
        title={board.board?.meta.title ?? place.board}
        mark={mark}
        state={repo}
        board={board.board}
        loading={board.loading}
        list={place.list}
        onMenu={openPanel}
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
        canChangeBoard={!!api && !!board.board}
        onBoardChange={boardChange.run}
        boardError={boardChange.error}
        onSettings={() => go({ ...place, settings: true })}
      />
    )
  }

  // The drawer from the right: the new-card form, or a card.
  let drawer: ReactNode = null
  if (place.repo && place.board && place.adding) {
    const list = place.list ?? board.board?.meta.lists.find(l => !l.archived)?.id
    drawer = (
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
  } else if (place.repo && place.board && place.card) {
    const card = board.board?.cards.find(c => c.id === place.card)
    const b = board.board
    drawer = (
      <CardView
        key={`${place.board}:${place.card}`}
        card={card}
        id={place.card}
        lists={b ? b.meta.lists.filter(l => !l.archived) : []}
        cards={b?.cards ?? []}
        doneList={b?.meta.flow?.done}
        linked={card ? linkedCards(cache, repo.snapshot, b, card.links) : []}
        canChange={!!api && !!card && !!b?.shas[card.id]}
        work={projectSettings(cache, repo.snapshot).work === true}
        onClose={() => go({ ...place, card: undefined })}
        onChange={async (change, overwrite) => {
          await changeCard(api!, cache, { repo: place.repo!, board: place.board! }, card!, b!.shas[card!.id], change, { overwrite })
          await repo.refresh()
          if (change.archived) go({ ...place, card: undefined })
        }}
        onOpen={l => go({ ...place, board: l.board ?? place.board, card: l.id })}
      />
    )
  }
  const covered = !!drawer || !!place.settings

  return (
    <div className="browse">
      {bar}
      <Images api={api} snapshot={repo.snapshot} board={place.board}>
        {screen}
        <Slide side="right" open={!!drawer} label="Card" onClose={() => go({ ...place, card: undefined, adding: undefined })}>
          {drawer}
        </Slide>
      </Images>
      <Slide
        side="left"
        open={!!place.panel}
        label="Boards and repos"
        className="panel"
        onOpen={covered ? undefined : openPanel}
        onClose={() => go({ ...place, panel: undefined })}
      >
        <Panel
          api={api}
          cache={cache}
          open={{ repo: place.repo, board: place.board, tree, main }}
          onPick={(r, b) =>
            go(r === place.repo && (b === place.board || !b) ? { ...place, panel: undefined } : { repo: r, board: b })
          }
          onSignOut={onSignOut}
        />
      </Slide>
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

/** Changes to the open board's board.json, one at a time, with why the last one failed. */
function useBoardChange(api: Session['api'] | undefined, cache: RepoCache, place: Place, refreshRepo: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => setError(undefined), [place.board, place.settings])
  const run = useCallback(
    async (change: BoardChange) => {
      if (!api || !place.repo || !place.board) return undefined
      setBusy(true)
      setError(undefined)
      try {
        const meta = await changeBoard(api, cache, { repo: place.repo, board: place.board }, change)
        await refreshRepo()
        return meta
      } catch (e) {
        if (e instanceof TypeError) setError('No connection: nothing was saved.')
        else if (!(e instanceof SignedOut)) setError((e as Error).message)
        return undefined
      } finally {
        setBusy(false)
      }
    },
    [api, cache, place.repo, place.board, refreshRepo],
  )
  return { busy, error, run }
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
