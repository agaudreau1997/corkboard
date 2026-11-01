// The companion: signed in, it browses your board repos; signed out, it still shows what it last
// read, with a bar to sign in again, and the sign-in screen only when it has nothing saved.

import { useEffect, useState } from 'react'
import { GITHUB_APP } from './github/config'
import { Session } from './github/session'
import { secureTokenStore } from './github/storage'
import { RepoCache } from './repo/cache'
import { Outbox } from './repo/outbox'
import { Browse, lastPlace } from './screens/Browse'
import { SignIn } from './screens/SignIn'

const session = new Session(secureTokenStore(), GITHUB_APP.clientId)
const cache = new RepoCache(localStorage)
const outbox = new Outbox(localStorage)

type State = { kind: 'loading' } | { kind: 'in' } | { kind: 'out'; message?: string; signingIn?: boolean }

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    const off = session.onSignedOut(message => setState({ kind: 'out', message }))
    session.restore().then(
      signedIn => setState(signedIn ? { kind: 'in' } : { kind: 'out' }),
      () => setState({ kind: 'out', message: 'The saved sign-in could not be read.' }),
    )
    return () => void off()
  }, [])

  if (state.kind === 'loading') return <main className="centred" />

  const saved = !!lastPlace().repo && !!cache.snapshot(lastPlace().repo!)
  if (state.kind === 'out' && (state.signingIn || !saved)) {
    return (
      <SignIn
        message={state.message}
        onBack={saved ? () => setState({ ...state, signingIn: false }) : undefined}
        onSignedIn={async tokens => {
          await session.signIn(tokens)
          setState({ kind: 'in' })
        }}
      />
    )
  }
  return (
    <Browse
      session={session}
      cache={cache}
      outbox={outbox}
      signedOut={state.kind === 'out' ? (state.message ?? 'Signed out.') : undefined}
      onSignIn={() => setState({ kind: 'out', message: state.kind === 'out' ? state.message : undefined, signingIn: true })}
      onSignOut={async () => {
        await session.signOut()
        setState({ kind: 'out', signingIn: true })
      }}
    />
  )
}
