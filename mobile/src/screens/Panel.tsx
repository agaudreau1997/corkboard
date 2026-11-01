// The side panel, the phone's version of the desktop's (src/renderer/src/components/Sidebar.tsx):
// *Corkboard* at its head, then every board repo the GitHub App reaches as a project row (its icon
// or swatch, its name), its boards nested under it (`panelRows`), the open one highlighted. It is
// the way between boards and repos: a repo's row opens its main board, a board's row that board.
// Its foot holds who's signed in, the way to add or remove repos on GitHub, and *Sign out*. It
// wears the open repo's colours, as the desktop's side panel wears the project in front's.
//
// It is drawn only while it shows, so each time it opens, the repos come from what was last read,
// then are read again behind it, as are their looks (only the files that changed). A repo's boards
// are what the phone last read of it: one never opened shows no boards until it is. Which repos
// are folded and which boards are open is remembered.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { App as CapApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { mainBoardOf } from '@shared/project'
import { installUrl } from '../github/config'
import { reach, type Reach } from '../github/installations'
import { SignedOut, type Session } from '../github/session'
import { Icon } from '../Icon'
import type { RepoCache } from '../repo/cache'
import { boardTree, type BoardNode } from '../repo/layout'
import { readLooks, type Look } from '../repo/looks'
import { boardKey, panelRows, type PanelRepo } from '../repo/panel'
import { boardMetas } from '../repo/reader'
import { ProjectMark } from './ProjectMark'
import './panel.css'

const REACH = 'corkboard:reach'
const FOLDED = 'corkboard:panel-folded'
const EXPANDED = 'corkboard:panel-expanded'

function stored<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback
  } catch {
    return fallback
  }
}

/** A remembered set of names, toggled one at a time. */
function useStoredSet(key: string): [Set<string>, (name: string) => void] {
  const [set, setSet] = useState(() => new Set(stored<string[]>(key, [])))
  const toggle = useCallback(
    (name: string) =>
      setSet(old => {
        const next = new Set(old)
        if (!next.delete(name)) next.add(name)
        localStorage.setItem(key, JSON.stringify([...next]))
        return next
      }),
    [key],
  )
  return [set, toggle]
}

export function Panel(props: {
  api: Session['api'] | undefined
  cache: RepoCache
  /** The open repo's boards, from its latest read (the others' come from the cache). */
  open: { repo?: string; board?: string; tree: BoardNode[]; main?: string }
  onPick: (repo: string, board: string | undefined) => void
  onSignOut: () => Promise<void>
}) {
  const { api, cache, open, onPick, onSignOut } = props
  const [known, setKnown] = useState<Reach | undefined>(() => stored<Reach | undefined>(REACH, undefined))
  const [error, setError] = useState<string>()
  const [looks, setLooks] = useState<Map<string, Look>>(new Map())
  const [folded, toggleFolded] = useStoredSet(FOLDED)
  const [expanded, toggleExpanded] = useStoredSet(EXPANDED)

  const look = useCallback(async () => {
    if (!api) return
    try {
      const got = await reach(api)
      localStorage.setItem(REACH, JSON.stringify(got))
      setKnown(got)
      setError(undefined)
      // The colours and icons only dress the rows: a failure leaves what was last read.
      setLooks(await readLooks(api, cache, got.repos).catch(() => new Map()))
    } catch (e) {
      if (!(e instanceof SignedOut)) setError((e as Error).message)
    }
  }, [api, cache])

  useEffect(() => {
    void look()
    // Back from the browser, after installing the app on more repos, say.
    const handle = CapApp.addListener('resume', () => void look())
    return () => void handle.then(h => h.remove())
  }, [look])

  const lookOf = (repo: string) => looks.get(repo) ?? cache.look(repo)
  const repos: PanelRepo[] = useMemo(
    () =>
      (known?.repos ?? (open.repo ? [open.repo] : [])).map(repo => {
        if (repo === open.repo) return { repo, tree: open.tree, main: open.main }
        const snapshot = cache.snapshot(repo)
        if (!snapshot) return { repo }
        const tree = boardTree(boardMetas(cache, snapshot))
        return { repo, tree, main: mainBoardOf({ board: (looks.get(repo) ?? cache.look(repo))?.settings.board }, tree) }
      }),
    [known, looks, open.repo, open.tree, open.main, cache],
  )
  const rows = panelRows(repos, folded, expanded, open)

  return (
    <>
      <div className="panel-head">
        <span className="brand">Corkboard</span>
      </div>
      <div className="panel-tree" role="tree">
        {error && <p className="note error">{error}</p>}
        {!known && !error && <p className="note">{api ? 'Looking at your GitHub account…' : 'Sign in to see your board repos.'}</p>}
        {known && !known.repos.length && (
          <div className="panel-empty">
            <p>The Corkboard app isn’t installed on any of your repos yet. Install it on your board repos only: it can’t reach the rest.</p>
            <button className="primary" type="button" onClick={() => void Browser.open({ url: installUrl() })}>
              Install on GitHub
            </button>
          </div>
        )}
        {rows.map(row =>
          row.kind === 'repo' ? (
            <div
              key={row.repo}
              role="treeitem"
              aria-expanded={row.foldable ? row.open : undefined}
              aria-current={row.active ? 'page' : undefined}
              className={`panel-repo${row.active ? ' active' : ''}${row.repo === open.repo ? ' open' : ''}`}
              title={row.repo}
              onClick={() => onPick(row.repo, row.main)}
            >
              <Twisty open={row.open} hidden={!row.foldable} onToggle={() => toggleFolded(row.repo)} />
              <ProjectMark look={lookOf(row.repo)} />
              <span className="panel-repo-name">{row.repo.split('/')[1]}</span>
            </div>
          ) : (
            <div
              key={boardKey(row.repo, row.node.path)}
              role="treeitem"
              aria-expanded={row.foldable ? row.open : undefined}
              aria-current={row.active ? 'page' : undefined}
              className={`panel-board${row.active ? ' active' : ''}`}
              style={{ paddingLeft: 4 + row.depth * 18 }}
              onClick={() => onPick(row.repo, row.node.path)}
            >
              <Twisty open={row.open} hidden={!row.foldable} onToggle={() => toggleExpanded(boardKey(row.repo, row.node.path))} />
              <span className="panel-board-icon">▦</span>
              <span className="panel-board-title">{row.node.title || row.node.path}</span>
              <span className="panel-board-key">{row.node.key}</span>
            </div>
          ),
        )}
      </div>
      <footer className="panel-foot">
        {known && <span className="panel-foot-text">Signed in as {known.login}</span>}
        <button className="panel-foot-button" type="button" onClick={() => void Browser.open({ url: installUrl() })}>
          Add or remove repos on GitHub
        </button>
        {api && (
          <button className="panel-foot-button" type="button" onClick={() => void onSignOut()}>
            Sign out
          </button>
        )}
      </footer>
    </>
  )
}

/** The arrow that folds a repo or opens a board's children, as the desktop's: a tap on it stays on it. */
function Twisty({ open, hidden, onToggle }: { open: boolean; hidden?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`twisty${open ? ' open' : ''}${hidden ? ' hidden' : ''}`}
      aria-label={open ? 'Collapse' : 'Expand'}
      aria-expanded={open}
      tabIndex={hidden ? -1 : undefined}
      onClick={e => {
        e.stopPropagation()
        onToggle()
      }}
    >
      <Icon name="chevron-right" />
    </button>
  )
}
