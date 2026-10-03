// Keeps the board repo in step with its remote, for a board used from several machines.
//
// A sync commits what is pending, fetches, rebases the local commits onto the remote branch and
// pushes. It runs at start, every minute, when the window gets focus and a moment after every
// auto-commit. Conflicts are rare (one file per card) and resolved without asking where the
// answer is clear: a card keeps the side edited last (its `updated` stamp), a map keeps every
// position, a board.json keeps every list. Anything else aborts the rebase and reports it.

import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { parseCard } from '@shared/cardfile'
import type { BoardMap, BoardMeta, SyncStatus } from '@shared/types'
import { type AutoCommitter, git, isRepo } from './git'

const NETWORK_TIMEOUT_MS = 30_000

export class BoardSync {
  status: SyncStatus = { state: 'idle' }
  private timer?: NodeJS.Timeout
  private pushTimer?: NodeJS.Timeout
  private running?: Promise<SyncStatus>
  private again = false
  private stopped = false

  constructor(
    private root: string,
    private committer: AutoCommitter,
    private onStatus: (status: SyncStatus) => void,
    private intervalMs = 60_000,
  ) {}

  start(): void {
    void this.sync()
    if (this.intervalMs > 0) this.timer = setInterval(() => void this.sync(), this.intervalMs)
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    clearTimeout(this.pushTimer)
  }

  /** After a local commit: push soon, folding a burst of commits into one push. */
  schedulePush(delayMs = 2000): void {
    clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.sync(), delayMs)
  }

  /** A sync unless one ran in the last `minGapMs` (window focus calls this). */
  syncIfStale(minGapMs = 15_000): void {
    if (!this.status.at || Date.now() - this.status.at > minGapMs) void this.sync()
  }

  sync(): Promise<SyncStatus> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.run().finally(() => {
      this.running = undefined
      if (this.again && !this.stopped) {
        this.again = false
        void this.sync()
      }
    })
    return this.running
  }

  private set(status: SyncStatus): SyncStatus {
    this.status = status
    this.onStatus(status)
    return status
  }

  private async run(): Promise<SyncStatus> {
    const last = this.status.at
    if (!(await isRepo(this.root))) return this.set({ state: 'local', message: 'Not a git repo' })
    const remote = (await git(this.root, ['remote'])).split('\n')[0]?.trim()
    if (!remote) return this.set({ state: 'local', message: 'No remote: changes stay on this machine' })
    if (this.rebaseInProgress()) {
      return this.set({ state: 'conflict', at: last, message: 'A rebase is in progress in the board repo; finish or abort it' })
    }
    this.set({ ...this.status, state: 'syncing' })

    await this.committer.flush()
    const branch = (await git(this.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    try {
      await git(this.root, ['fetch', '--quiet', remote], NETWORK_TIMEOUT_MS)
    } catch (error) {
      return this.set({ state: 'offline', at: last, message: firstLine(error) })
    }

    const upstream = `${remote}/${branch}`
    const hasUpstream = await git(this.root, ['rev-parse', '--verify', '-q', `refs/remotes/${upstream}`]).then(
      () => true,
      () => false,
    )
    let pulled = 0
    if (hasUpstream) {
      const { behind } = await this.counts(upstream)
      if (behind > 0) {
        const outcome = await this.rebase(upstream)
        if (outcome !== true) return this.set({ state: 'conflict', at: last, message: outcome })
        pulled = behind
      }
    }

    const ahead = hasUpstream ? (await this.counts(upstream)).ahead : 1
    if (ahead > 0) {
      try {
        await git(this.root, ['push', '--quiet', '-u', remote, branch], NETWORK_TIMEOUT_MS)
      } catch (error) {
        // Someone pushed between our fetch and our push: go round again shortly.
        if (/rejected|non-fast-forward|fetch first/i.test(String(error))) this.schedulePush(3000)
        return this.set({ state: 'offline', at: last, message: firstLine(error) })
      }
    }
    return this.set({ state: 'synced', at: Date.now(), pulled, pushed: ahead })
  }

  private async counts(upstream: string): Promise<{ ahead: number; behind: number }> {
    const out = await git(this.root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
    const [ahead, behind] = out.trim().split(/\s+/).map(Number)
    return { ahead: ahead || 0, behind: behind || 0 }
  }

  private rebaseInProgress(): boolean {
    return (
      existsSync(path.join(this.root, '.git', 'rebase-merge')) ||
      existsSync(path.join(this.root, '.git', 'rebase-apply'))
    )
  }

  /** true, or why it gave up (the rebase is aborted then, leaving the repo as it was). */
  private async rebase(upstream: string): Promise<true | string> {
    try {
      await git(this.root, ['rebase', '--autostash', upstream])
      return true
    } catch {
      /* conflicts: resolve them below, commit by commit */
    }
    for (let round = 0; round < 200 && this.rebaseInProgress(); round++) {
      const conflicted = (await git(this.root, ['diff', '--name-only', '--diff-filter=U']))
        .split('\n')
        .filter(Boolean)
      for (const file of conflicted) {
        if (!(await this.resolve(file))) {
          await git(this.root, ['rebase', '--abort']).catch(() => {})
          return `Could not merge ${file} automatically; resolve it in the board repo (git status)`
        }
      }
      try {
        await git(this.root, ['rebase', '--continue'])
      } catch (error) {
        // The commit became empty once resolved (the remote already had it): skip it.
        const left = (await git(this.root, ['diff', '--name-only', '--diff-filter=U'])).trim()
        if (!left && /nothing to commit|no changes|empty/i.test(String(error))) {
          await git(this.root, ['rebase', '--skip']).catch(() => {})
        }
      }
    }
    if (this.rebaseInProgress()) {
      await git(this.root, ['rebase', '--abort']).catch(() => {})
      return 'The rebase did not finish; nothing was changed'
    }
    return true
  }

  /**
   * During a rebase, stage 2 is the remote side (what we are rebasing onto) and stage 3 is the
   * local commit being replayed.
   */
  private async resolve(file: string): Promise<boolean> {
    const remote = await this.stage(2, file)
    const local = await this.stage(3, file)
    const abs = path.join(this.root, file)
    const name = path.posix.basename(file)
    let merged: string | null | undefined

    if (remote === undefined && local === undefined) merged = null
    else if (remote === undefined) merged = local!
    else if (local === undefined) merged = remote
    else if (name.endsWith('.md') && path.posix.basename(path.posix.dirname(file)) === 'cards') {
      merged = newerCard(remote, local)
    } else if (name === 'map.json') {
      merged = mergeMaps(remote, local)
    } else if (name === 'board.json') {
      merged = mergeBoards(remote, local)
    } else {
      return false
    }
    if (merged === undefined) return false
    if (merged === null) {
      await git(this.root, ['rm', '-q', '--', file])
    } else {
      await fs.writeFile(abs, merged)
      await git(this.root, ['add', '--', file])
    }
    return true
  }

  private stage(n: 2 | 3, file: string): Promise<string | undefined> {
    return git(this.root, ['show', `:${n}:${file}`]).catch(() => undefined)
  }
}

/** The side whose card was edited last; the local one on a tie or with no stamps. */
export function newerCard(remote: string, local: string): string {
  const r = parseCard(remote).updated ?? ''
  const l = parseCard(local).updated ?? ''
  return r > l ? remote : local
}

/** Every position from both sides (the local one where both moved a card), local settings. */
export function mergeMaps(remote: string, local: string): string | undefined {
  try {
    const r = JSON.parse(remote) as BoardMap
    const l = JSON.parse(local) as BoardMap
    const areas = r.areas || l.areas ? { areas: { ...r.areas, ...l.areas } } : {}
    return `${JSON.stringify({ ...r, ...l, nodes: { ...r.nodes, ...l.nodes }, ...areas }, null, 2)}\n`
  } catch {
    return undefined
  }
}

/** The local board settings, with every list either side has, in the remote order first. */
export function mergeBoards(remote: string, local: string): string | undefined {
  try {
    const r = JSON.parse(remote) as BoardMeta
    const l = JSON.parse(local) as BoardMeta
    const localById = new Map(l.lists.map(x => [x.id, x]))
    const lists = r.lists.map(x => localById.get(x.id) ?? x)
    for (const x of l.lists) if (!lists.some(y => y.id === x.id)) lists.push(x)
    return `${JSON.stringify({ ...r, ...l, lists }, null, 2)}\n`
  } catch {
    return undefined
  }
}

function firstLine(error: unknown): string {
  return String((error as Error)?.message ?? error).split('\n')[0].slice(0, 200)
}
