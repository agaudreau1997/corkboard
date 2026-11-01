// The first screen: the board repos the GitHub App can reach, each with its icon or colour swatch,
// or the step to install it when it reaches none. It stays in the app's own colours. The repos'
// looks are drawn from what was last read, then read again behind it (only the files that changed).

import { useCallback, useEffect, useState } from 'react'
import { App as CapApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { installUrl } from '../github/config'
import { reach, type Reach } from '../github/installations'
import { SignedOut, type Session } from '../github/session'
import type { RepoCache } from '../repo/cache'
import { readLooks, type Look } from '../repo/looks'
import { Header, Pull } from './parts'
import { ProjectMark } from './ProjectMark'

const REACH = 'corkboard:reach'

export function Repos(props: {
  api: Session['api'] | undefined
  cache: RepoCache
  onPick: (repo: string) => void
  onSignOut: () => Promise<void>
}) {
  const { api, cache, onPick, onSignOut } = props
  const [known, setKnown] = useState<Reach | undefined>(() => {
    try {
      return JSON.parse(localStorage.getItem(REACH) ?? 'null') ?? undefined
    } catch {
      return undefined
    }
  })
  const [error, setError] = useState<string>()
  const [looks, setLooks] = useState<Map<string, Look>>(new Map())

  const look = useCallback(async () => {
    if (!api) return
    try {
      const got = await reach(api)
      localStorage.setItem(REACH, JSON.stringify(got))
      setKnown(got)
      setError(undefined)
      // The colours and icons only dress the list: a failure leaves what was last read.
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
              <button type="button" className="repo-row" onClick={() => onPick(r)}>
                <ProjectMark look={looks.get(r) ?? cache.look(r)} />
                <span className="repo-names">
                  <span className="row-title">{r.split('/')[1]}</span>
                  <span className="row-sub">{r.split('/')[0]}</span>
                </span>
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
