// Reading a board repo through GitHub, not git: the default branch's tree in one call, then the
// files it names that the cache doesn't hold yet, in GraphQL batches. A refresh is the tree again
// and only the files whose sha changed. Boards' `board.json` files are read with the tree (there
// are few); a board's cards when it is opened. Offline, or signed out, everything comes from the
// cache, and a board shows the cards the cache holds.

import { tryParseCard } from '@shared/cardfile'
import type { BoardMeta, Card } from '@shared/types'
import { answerJson as json } from '../github/answer'
import { readBlobs } from './blobs'
import type { RepoCache, Snapshot } from './cache'
import { findBoards, findImages, parseMeta, type TreeEntry } from './layout'

type Api = (path: string, init?: RequestInit) => Promise<Response>

export type Board = {
  path: string
  meta: BoardMeta
  cards: Card[]
  /** Each card's blob sha as read: a change is written against it. */
  shas: Record<string, string>
  /** Card files the cache doesn't hold (opened offline before they were ever read). */
  missing: number
}

/** Reads the tree and every board's `board.json`, keeps them, and answers the new snapshot. */
export async function refresh(api: Api, cache: RepoCache, repo: string, now = new Date()): Promise<Snapshot> {
  const info = await json<{ default_branch: string }>(await api(`/repos/${repo}`), repo)
  const tree = await json<{ sha: string; truncated: boolean; tree: TreeEntry[] }>(
    await api(`/repos/${repo}/git/trees/${encodeURIComponent(info.default_branch)}?recursive=1`),
    `${repo}'s files`,
  )
  const boards = findBoards(tree.tree)
  await fetchMissing(api, cache, repo, boards.map(b => b.meta.sha))
  const snapshot: Snapshot = {
    repo,
    branch: info.default_branch,
    tree: tree.sha,
    truncated: tree.truncated,
    boards,
    images: findImages(tree.tree),
    read: now.toISOString(),
  }
  cache.putSnapshot(snapshot)
  return snapshot
}

/** A board's cards: read the ones the cache lacks (unless `offline`), then parse them all. */
export async function openBoard(api: Api | undefined, cache: RepoCache, snapshot: Snapshot, path: string): Promise<Board | undefined> {
  const files = snapshot.boards.find(b => b.path === path)
  const meta = files && parseMeta(cache.blob(files.meta.sha) ?? '')
  if (!files || !meta) return undefined
  if (api) await fetchMissing(api, cache, snapshot.repo, files.cards.map(c => c.sha))
  const cards: Card[] = []
  const shas: Record<string, string> = {}
  let missing = 0
  for (const file of files.cards) {
    const text = cache.blob(file.sha)
    const card = text === undefined ? undefined : tryParseCard(text, file.id)
    if (card) {
      cards.push(card)
      shas[card.id] = file.sha
    } else if (text === undefined) missing++
  }
  return { path, meta, cards, shas, missing }
}

/** The boards' metas from the cache, for the board list. */
export function boardMetas(cache: RepoCache, snapshot: Snapshot): { path: string; meta: BoardMeta }[] {
  return snapshot.boards.flatMap(b => {
    const meta = parseMeta(cache.blob(b.meta.sha) ?? '')
    return meta ? [{ path: b.path, meta }] : []
  })
}

async function fetchMissing(api: Api, cache: RepoCache, repo: string, shas: string[]): Promise<void> {
  const missing = [...new Set(shas)].filter(sha => cache.blob(sha) === undefined)
  if (missing.length) cache.putBlobs(await readBlobs(api, repo, missing))
}
