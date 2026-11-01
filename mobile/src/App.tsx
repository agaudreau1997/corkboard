// The companion's one screen for now: signed out. Signing in with GitHub's device flow comes next,
// and the boards after it.

export function App() {
  return (
    <main className="signed-out">
      <h1>Corkboard</h1>
      <p>Your board repos' cards, on the go.</p>
      <button className="primary" type="button" disabled>
        Sign in with GitHub
      </button>
      <p className="hint">Signing in isn't built yet.</p>
    </main>
  )
}
