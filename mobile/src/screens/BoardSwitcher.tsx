// The way between a repo's boards, opened from the board header's title: a sheet listing them as
// the desktop's side panel lists a project. The repo's row is its main board; under it, the main
// board's child boards and the other top-level boards (`sideBoards`), each with its children
// nested. They're in title order: the desktop's dragged order is per machine, so the phone can't
// know it.

import type { ReactNode } from 'react'
import { sideBoards } from '@shared/project'
import type { BoardNode } from '../repo/layout'
import type { Look } from '../repo/looks'
import { ProjectMark } from './ProjectMark'
import './BoardSwitcher.css'

export function BoardSwitcher(props: {
  repo: string
  look: Look | undefined
  tree: BoardNode[]
  main: string | undefined
  current: string | undefined
  /** GitHub cut the repo's file list short: some boards may be missing. */
  truncated?: boolean
  onPick: (path: string) => void
  onClose: () => void
}) {
  const { repo, look, tree, main, current, truncated, onPick, onClose } = props
  const mainBoard = tree.find(b => b.path === main)
  const rows: ReactNode[] = []
  const row = (path: string, title: ReactNode, sub: string, depth: number, lead?: ReactNode) =>
    rows.push(
      <li key={path}>
        <button
          type="button"
          className={path === current ? 'current' : undefined}
          aria-current={path === current ? 'page' : undefined}
          style={{ paddingLeft: 16 + depth * 20 }}
          onClick={() => onPick(path)}
        >
          {lead}
          <span className="switch-names">
            <span className="row-title">{title}</span>
            <span className="row-sub">{sub}</span>
          </span>
        </button>
      </li>,
    )
  const walk = (nodes: BoardNode[], depth: number) => {
    for (const node of nodes) {
      row(node.path, node.title || node.path, node.key, depth)
      walk(node.children, depth + 1)
    }
  }
  if (mainBoard) row(mainBoard.path, repo.split('/')[1], `${mainBoard.title || mainBoard.path} · main board`, 0, <ProjectMark look={look} />)
  walk(sideBoards(tree, main), mainBoard ? 1 : 0)

  return (
    <div className="switcher-backdrop" onClick={onClose}>
      <nav className="switcher" aria-label="Boards" onClick={e => e.stopPropagation()}>
        <h2>Boards</h2>
        {truncated && <p className="note">GitHub cut this repo's file list short: some boards may be missing.</p>}
        <ul className="rows">{rows}</ul>
      </nav>
    </div>
  )
}
