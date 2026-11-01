// A repo's boards, child boards under their parents.

import type { ReactNode } from 'react'
import type { BoardNode } from '../repo/layout'
import type { RepoState } from './Browse'
import { Header, Pull } from './parts'

export function Boards(props: { repo: string; state: RepoState; tree: BoardNode[]; onBack: () => void; onPick: (path: string) => void }) {
  const { repo, state, tree, onBack, onPick } = props
  const rows: ReactNode[] = []
  const walk = (nodes: BoardNode[], depth: number) => {
    for (const node of nodes) {
      rows.push(
        <li key={node.path}>
          <button type="button" style={{ paddingLeft: 16 + depth * 20 }} onClick={() => onPick(node.path)}>
            <span className="row-title">{node.title || node.path}</span>
            <span className="row-sub">{node.key}</span>
          </button>
        </li>,
      )
      walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)
  return (
    <>
      <Header title={repo.split('/')[1]} sub="Boards" onBack={onBack} busy={state.busy} />
      <Pull onRefresh={state.refresh}>
        {state.error && <p className="note error">{state.error}</p>}
        {state.snapshot?.truncated && <p className="note">GitHub cut this repo's file list short: some boards may be missing.</p>}
        {!state.snapshot && !state.error && <p className="note">Reading the repo…</p>}
        {state.snapshot && !rows.length && <p className="note">No boards in this repo.</p>}
        <ul className="rows">{rows}</ul>
      </Pull>
    </>
  )
}
