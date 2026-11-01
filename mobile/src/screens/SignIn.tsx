// Signing in with GitHub's device flow: a code to approve at github.com/login/device, copied and
// opened in the browser, where you're usually signed in already. The app polls until you approve.

import { useEffect, useRef, useState } from 'react'
import { Browser } from '@capacitor/browser'
import { AuthError, pollForTokens, requestDeviceCode, type DeviceCode, type Tokens } from '../github/auth'
import { GITHUB_APP } from '../github/config'

type Props = {
  message?: string
  onSignedIn: (tokens: Tokens) => Promise<void>
  /** Shown when there is a cached board to go back to. */
  onBack?: () => void
}

export function SignIn({ message, onSignedIn, onBack }: Props) {
  const [code, setCode] = useState<DeviceCode>()
  const [error, setError] = useState(message)
  const polling = useRef<AbortController | undefined>(undefined)

  useEffect(() => () => polling.current?.abort(), [])

  async function start() {
    polling.current?.abort()
    const controller = new AbortController()
    polling.current = controller
    setError(undefined)
    try {
      const got = await requestDeviceCode(fetch, GITHUB_APP.clientId)
      setCode(got)
      await openGitHub(got)
      const tokens = await pollForTokens(fetch, GITHUB_APP.clientId, got, { signal: controller.signal })
      void Browser.close().catch(() => {})
      await onSignedIn(tokens)
    } catch (e) {
      if (controller.signal.aborted) return
      setCode(undefined)
      setError(e instanceof AuthError ? e.message : String(e))
    }
  }

  function cancel() {
    polling.current?.abort()
    setCode(undefined)
  }

  if (code) {
    return (
      <main className="centred">
        <h1>Approve on GitHub</h1>
        <p>Enter this code at github.com/login/device. It's on your clipboard.</p>
        <p className="code">{code.userCode}</p>
        <button className="primary" type="button" onClick={() => openGitHub(code)}>
          Open GitHub
        </button>
        <p className="hint">Waiting for you to approve…</p>
        <button className="plain" type="button" onClick={cancel}>
          Cancel
        </button>
      </main>
    )
  }
  return (
    <main className="centred">
      <h1>Corkboard</h1>
      <p>Your board repos' cards, on the go.</p>
      <button className="primary" type="button" onClick={start}>
        Sign in with GitHub
      </button>
      {error && <p className="error">{error}</p>}
      {onBack && (
        <button className="plain" type="button" onClick={onBack}>
          Back to the saved boards
        </button>
      )}
    </main>
  )
}

async function openGitHub(code: DeviceCode) {
  await navigator.clipboard?.writeText(code.userCode).catch(() => {})
  await Browser.open({ url: code.verificationUri })
}
