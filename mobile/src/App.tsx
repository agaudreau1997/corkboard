// The companion's screens so far: signing in with GitHub's device flow, and what the sign-in
// reaches. The boards come next. Signing in shows a code, copies it and opens github.com/login/device
// in the browser, where you're usually signed in already; the app polls until you approve.

import { useCallback, useEffect, useRef, useState } from 'react'
import { App as CapApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { AuthError, pollForTokens, requestDeviceCode, type DeviceCode } from './github/auth'
import { GITHUB_APP, installUrl } from './github/config'
import { reach, type Reach } from './github/installations'
import { Session, SignedOut } from './github/session'
import { secureTokenStore } from './github/storage'

const session = new Session(secureTokenStore(), GITHUB_APP.clientId)

type Screen =
  | { kind: 'loading' }
  | { kind: 'signed-out'; message?: string }
  | { kind: 'code'; code: DeviceCode }
  | { kind: 'signed-in'; reach?: Reach; error?: string }

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const polling = useRef<AbortController | undefined>(undefined)

  const look = useCallback(async () => {
    try {
      setScreen({ kind: 'signed-in', reach: await reach(session) })
    } catch (error) {
      if (error instanceof SignedOut) return
      setScreen(s => ({ kind: 'signed-in', reach: s.kind === 'signed-in' ? s.reach : undefined, error: (error as Error).message }))
    }
  }, [])

  useEffect(() => {
    const off = session.onSignedOut(message => setScreen({ kind: 'signed-out', message }))
    session.restore().then(
      signedIn => (signedIn ? look() : setScreen({ kind: 'signed-out' })),
      () => setScreen({ kind: 'signed-out', message: 'The saved sign-in could not be read.' }),
    )
    // Back from the browser (after installing the app, say): look again.
    const resumed = CapApp.addListener('resume', () => {
      if (session.signedIn) void look()
    })
    return () => {
      off()
      void resumed.then(handle => handle.remove())
    }
  }, [look])

  async function signIn() {
    polling.current?.abort()
    const controller = new AbortController()
    polling.current = controller
    try {
      const code = await requestDeviceCode(fetch, GITHUB_APP.clientId)
      setScreen({ kind: 'code', code })
      await openGitHub(code)
      const tokens = await pollForTokens(fetch, GITHUB_APP.clientId, code, { signal: controller.signal })
      await session.signIn(tokens)
      setScreen({ kind: 'signed-in' })
      void Browser.close().catch(() => {})
      await look()
    } catch (error) {
      if (controller.signal.aborted) return
      setScreen({ kind: 'signed-out', message: error instanceof AuthError ? error.message : String(error) })
    }
  }

  function cancel() {
    polling.current?.abort()
    setScreen({ kind: 'signed-out' })
  }

  async function signOut() {
    polling.current?.abort()
    await session.signOut()
    setScreen({ kind: 'signed-out' })
  }

  switch (screen.kind) {
    case 'loading':
      return <main className="centred" />
    case 'signed-out':
      return (
        <main className="centred">
          <h1>Corkboard</h1>
          <p>Your board repos' cards, on the go.</p>
          <button className="primary" type="button" onClick={signIn}>
            Sign in with GitHub
          </button>
          {screen.message && <p className="error">{screen.message}</p>}
        </main>
      )
    case 'code':
      return (
        <main className="centred">
          <h1>Approve on GitHub</h1>
          <p>Enter this code at github.com/login/device. It's on your clipboard.</p>
          <p className="code">{screen.code.userCode}</p>
          <button className="primary" type="button" onClick={() => openGitHub(screen.code)}>
            Open GitHub
          </button>
          <p className="hint">Waiting for you to approve…</p>
          <button className="plain" type="button" onClick={cancel}>
            Cancel
          </button>
        </main>
      )
    case 'signed-in':
      return (
        <main className="centred">
          {!screen.reach ? (
            <p className="hint">{screen.error ?? 'Looking at your GitHub account…'}</p>
          ) : screen.reach.repos.length ? (
            <>
              <h1>Signed in</h1>
              <p>As {screen.reach.login}, with access to:</p>
              <ul className="repos">
                {screen.reach.repos.map(repo => (
                  <li key={repo}>{repo}</li>
                ))}
              </ul>
              <p className="hint">Browsing these boards comes next.</p>
            </>
          ) : (
            <>
              <h1>One more step</h1>
              <p>
                Signed in as {screen.reach.login}, but the Corkboard app isn't installed on any of your repos yet. Install
                it on your board repos only: it can't reach the rest.
              </p>
              <button className="primary" type="button" onClick={() => Browser.open({ url: installUrl() })}>
                Install on GitHub
              </button>
            </>
          )}
          {screen.reach && screen.error && <p className="error">{screen.error}</p>}
          <button className="plain" type="button" onClick={signOut}>
            Sign out
          </button>
        </main>
      )
  }
}

async function openGitHub(code: DeviceCode) {
  await navigator.clipboard?.writeText(code.userCode).catch(() => {})
  await Browser.open({ url: code.verificationUri })
}
