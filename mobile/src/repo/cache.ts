// The last read of each board repo, kept on the phone so the app opens instantly and offline, then
// refreshes. Files are kept by blob sha (a sha names its content, so a kept file is never stale)
// and a repo's snapshot is its tree as last read. Board files aren't secrets: the WebView's
// localStorage is enough, and is a few hundred kilobytes for a board repo.

import type { BoardFiles } from './layout'

export type Snapshot = {
  repo: string
  branch: string
  /** The tree's sha: unchanged, nothing in the repo changed. */
  tree: string
  /** GitHub cut the tree short (a huge repo): some boards may be missing. */
  truncated: boolean
  boards: BoardFiles[]
  /** The images in the tree, path to blob sha (missing from a snapshot an older build kept). */
  images?: Record<string, string>
  read: string
}

const BLOB = 'corkboard:blob:'
const SNAPSHOT = 'corkboard:snapshot:'

export class RepoCache {
  constructor(private readonly storage: Storage) {}

  blob(sha: string): string | undefined {
    return this.storage.getItem(BLOB + sha) ?? undefined
  }

  putBlobs(blobs: Map<string, string>): void {
    for (const [sha, text] of blobs) this.storage.setItem(BLOB + sha, text)
  }

  snapshot(repo: string): Snapshot | undefined {
    const text = this.storage.getItem(SNAPSHOT + repo)
    if (!text) return undefined
    try {
      return JSON.parse(text) as Snapshot
    } catch {
      return undefined
    }
  }

  /** Keeps the snapshot, then drops the files no kept snapshot names any more. */
  putSnapshot(snapshot: Snapshot): void {
    this.storage.setItem(SNAPSHOT + snapshot.repo, JSON.stringify(snapshot))
    const named = new Set<string>()
    const keys = Array.from({ length: this.storage.length }, (_, i) => this.storage.key(i) ?? '')
    for (const key of keys.filter(k => k.startsWith(SNAPSHOT))) {
      const kept = this.snapshot(key.slice(SNAPSHOT.length))
      for (const board of kept?.boards ?? []) {
        named.add(board.meta.sha)
        for (const card of board.cards) named.add(card.sha)
      }
    }
    for (const key of keys) if (key.startsWith(BLOB) && !named.has(key.slice(BLOB.length))) this.storage.removeItem(key)
  }
}
