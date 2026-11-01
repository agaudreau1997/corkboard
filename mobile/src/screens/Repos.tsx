// The first screen: the board repos the GitHub App can reach, or the step to install it when it
// reaches none.

import { useCallback, useEffect, useState } from 'react'
import { App as CapApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { installUrl } from '../github/config'
import { reach, type Reach } from '../github/installations'
import { SignedOut, type Session } from '../github/session'
import { Header, Pull } from './parts'

const REACH = 'corkboard:reach'

export function Repos({ api, onPick, onSignOut }: { api: Session['api'] | undefined; onPick: (repo: string) => void; onSignOut: () => Promise<void> }) {
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
