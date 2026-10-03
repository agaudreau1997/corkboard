import { useEffect } from 'react'
import { BoardPane } from './components/BoardPane'
import { CardDetail } from './components/CardDetail'
import { Modals } from './components/Modals'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { TerminalPanel } from './components/TerminalPanel'
import { actions, useStore } from './state'

export function App() {
  const config = useStore(s => s.config)
  const activeTab = useStore(s => s.activeTab)
  const toast = useStore(s => s.toast)
  const sidebarWidth = useStore(s => s.sidebarWidth)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        useStore.setState(s => ({ terminalOpen: !s.terminalOpen }))
      } else if (e.key === 'Escape' && !useStore.getState().modal) {
        actions.closeCard()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (config === undefined) return <div className="splash">Loading…</div>
  if (config === null) {
    return (
      <div className="splash">
        <h1>Corkboard</h1>
        <p>Choose the folder of your board repo (a git repo of board folders).</p>
        <button className="primary" onClick={() => void actions.pickRoot()}>
          Choose board repo…
        </button>
      </div>
    )
  }

  return (
    <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}>
      <Sidebar />
      <main className="main">
        <TabBar />
        <div className="workspace">
          {activeTab ? <BoardPane key={activeTab} path={activeTab} /> : <EmptyState />}
          <CardDetail />
        </div>
        <TerminalPanel />
      </main>
      <Modals />
      {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="empty-state">
      <p>Open a board from the side panel, or create one.</p>
      <button onClick={() => actions.setModal({ kind: 'newBoard', parent: '' })}>New board</button>
    </div>
  )
}
