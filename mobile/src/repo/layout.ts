// Where the boards are in a board repo, read from its git tree the way the desktop's store reads
// its folders: a folder (not the root) holding a `board.json` is a board, a sub-folder of one
// holding its own is a child board, and `.git`, `node_modules`, `cards` and dot folders are never
// boards. A board's cards are the `cards/<ID>.md` files right under it.

import { imageType } from '@shared/images'
import type { BoardMeta } from '@shared/types'

export type TreeEntry = { path: string; type: string; sha: string }

export type FileRef = { path: string; sha: string }

export type BoardFiles = {
  /** The board's folder in the repo, e.g. `cork` or `game/art`. */
  path: string
  meta: FileRef
  cards: (FileRef & { id: string })[]
}

const SKIP = new Set(['.git', 'node_modules', 'cards'])

function skipped(folder: string): boolean {
  return folder.split('/').some(part => SKIP.has(part) || part.startsWith('.'))
}

export function findBoards(entries: TreeEntry[]): BoardFiles[] {
  const boards = new Map<string, BoardFiles>()
  for (const entry of entries) {
    if (entry.type !== 'blob' || !entry.path.endsWith('/board.json')) continue
    const folder = entry.path.slice(0, -'/board.json'.length)
    if (skipped(folder)) continue
    boards.set(folder, { path: folder, meta: { path: entry.path, sha: entry.sha }, cards: [] })
  }
  for (const entry of entries) {
    const m = /^(.+)\/cards\/([^/]+)\.md$/.exec(entry.path)
    if (entry.type !== 'blob' || !m) continue
    boards.get(m[1])?.cards.push({ id: m[2], path: entry.path, sha: entry.sha })
  }
  return [...boards.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * The images in the tree, path to blob sha, for the cards' descriptions and covers to find theirs
 * by: the types the desktop keeps (`IMAGE_TYPES`), wherever they are (a description may name
 * another board's), but in hidden folders.
 */
export function findImages(entries: TreeEntry[]): Record<string, string> {
  const images: Record<string, string> = {}
  for (const entry of entries) {
    const hidden = entry.path.split('/').some(part => part.startsWith('.') || part === 'node_modules')
    if (entry.type === 'blob' && imageType(entry.path) && !hidden) images[entry.path] = entry.sha
  }
  return images
}

export type BoardNode = { path: string; title: string; key: string; children: BoardNode[] }

/** The boards nested under their parents, each level by title, as the desktop's side panel shows them. */
export function boardTree(boards: { path: string; meta: Pick<BoardMeta, 'title' | 'key'> }[]): BoardNode[] {
  const nodes = new Map(boards.map(b => [b.path, { path: b.path, title: b.meta.title, key: b.meta.key, children: [] as BoardNode[] }]))
  const roots: BoardNode[] = []
  for (const node of nodes.values()) {
    let parent = parentPath(node.path)
    while (parent !== undefined && !nodes.has(parent)) parent = parentPath(parent)
    if (parent === undefined) roots.push(node)
    else nodes.get(parent)!.children.push(node)
  }
  const order = (list: BoardNode[]) => {
    list.sort((a, b) => a.title.localeCompare(b.title))
    list.forEach(n => order(n.children))
  }
  order(roots)
  return roots
}

function parentPath(p: string): string | undefined {
  const i = p.lastIndexOf('/')
  return i < 0 ? undefined : p.slice(0, i)
}

/** A board.json's text as the desktop's store takes it: lists default to none; undefined if it doesn't parse. */
export function parseMeta(text: string): BoardMeta | undefined {
  try {
    const meta = JSON.parse(text) as BoardMeta
    if (!meta || typeof meta !== 'object') return undefined
    meta.lists ??= []
    meta.title ??= ''
    return meta
  } catch {
    return undefined
  }
}
