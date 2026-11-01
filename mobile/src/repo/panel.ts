// The side panel's rows, as the desktop's side panel lays out a project: the repo's row is the way
// to its main board, so that board isn't repeated; under it, folded by the row's twisty, the main
// board's child boards and the other top-level boards (`sideBoards`), each with its own children,
// which a board's twisty shows. The open board is highlighted, and the boards above it are shown
// open, so the highlight is never folded out of sight. A repo the phone hasn't read yet has a row
// and no boards: a tap opens it on its main board once read.

import { sideBoards } from '@shared/project'
import type { BoardNode } from './layout'

export type PanelRepo = {
  /** `owner/name`. */
  repo: string
  /** Its boards, nested; none when the phone hasn't read the repo yet. */
  tree?: BoardNode[]
  /** The board its row opens. */
  main?: string
}

export type PanelRow =
  | { kind: 'repo'; repo: string; main?: string; open: boolean; foldable: boolean; active: boolean }
  | { kind: 'board'; repo: string; node: BoardNode; depth: number; open: boolean; foldable: boolean; active: boolean }

/** A board's key in the panel's expanded set: boards of two repos may share a path. */
export const boardKey = (repo: string, path: string) => `${repo}:${path}`

/**
 * The panel's rows, in order. `folded` names the repos folded shut (a repo starts open, as on the
 * desktop); `expanded` the boards whose children show (a board starts shut, as on the desktop).
 */
export function panelRows(
  repos: PanelRepo[],
  folded: ReadonlySet<string>,
  expanded: ReadonlySet<string>,
  current: { repo?: string; board?: string },
): PanelRow[] {
  const rows: PanelRow[] = []
  for (const { repo, tree, main } of repos) {
    const here = current.repo === repo
    const listed = tree ? sideBoards(tree, main) : []
    const open = !folded.has(repo)
    rows.push({ kind: 'repo', repo, main, open, foldable: listed.length > 0, active: here && !!main && current.board === main })
    if (!open) continue
    const above = here && current.board ? ancestors(current.board) : new Set<string>()
    const walk = (nodes: BoardNode[], depth: number) => {
      for (const node of nodes) {
        const foldable = node.children.length > 0
        const shown = foldable && (expanded.has(boardKey(repo, node.path)) || above.has(node.path))
        rows.push({ kind: 'board', repo, node, depth, open: shown, foldable, active: here && current.board === node.path })
        if (shown) walk(node.children, depth + 1)
      }
    }
    walk(listed, 1)
  }
  return rows
}

/** The folders above a board's: `a/b/c` has `a` and `a/b`. */
function ancestors(path: string): Set<string> {
  const parts = path.split('/')
  return new Set(parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/')))
}
