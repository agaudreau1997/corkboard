// Git, both ways: the board repo is committed by the app after every quiet spell, and a board's
// code repo is read for the commits whose `Card:` trailers name its cards or, for a work project,
// whose message names a card's Jira key (teammates' commits on the same issue included). The code
// repo panel reads the code repo's branch and where it stands against its upstream, pushes and
// pulls it (fast-forward only), and watches its git folder so what it shows follows commits made
// in a terminal. Nothing here commits in the code repo.

import { execFile } from 'node:child_process'
import { existsSync, type FSWatcher, promises as fs, watch } from 'node:fs'
import path from 'node:path'
import { tryParseCard } from '@shared/cardfile'
import { cardImageOf } from '@shared/images'
import { namesKey, parseProjectSettings, PROJECT_FILE } from '@shared/project'
import { THEME_FILE } from '@shared/theme'
import type { CodeCommit, RepoStatus } from '@shared/types'

export function git(cwd: string, args: string[], timeoutMs = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        // Never wait on a prompt or an editor: a credential the helper lacks or a rebase that
        // wants a message fails instead of hanging the app.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message))
        else resolve(stdout)
      },
    )
  })
}

export async function isRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

const CARD_TRAILER = /^Card:\s*(.+)$/gim
const LOG_FORMAT = '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%B%x1e'

/**
 * Every commit on any branch whose message names a card with a `Card:` line, or names one of
 * `keys` (a work project's Jira keys). Git finds the keys as plain substrings (`-F`, several
 * `--grep` match any of them); the message is then read again here for the key between
 * non-alphanumerics, so ABC-12 is not found in ABC-123. The message only: a merge commit names
 * its branch in its subject, and the sessions name the key in every commit anyway.
 */
export async function codeCommits(repo: string, keys: string[] = []): Promise<CodeCommit[]> {
  const commits = new Map<string, CodeCommit>()
  for (const record of parseLog(await git(repo, ['log', '--all', '-i', '--grep=^Card:', LOG_FORMAT]))) {
    const cards = new Set<string>()
    for (const m of record.body.matchAll(CARD_TRAILER)) {
      for (const id of m[1].split(/[,\s]+/)) if (id) cards.add(id.trim().toUpperCase())
    }
    if (cards.size) commits.set(record.sha, { ...record.commit, cards: [...cards], keys: [] })
  }
  const wanted = [...new Set(keys.map(k => k.trim().toUpperCase()).filter(Boolean))]
  if (wanted.length) {
    const greps = wanted.map(k => `--grep=${k}`)
    for (const record of parseLog(await git(repo, ['log', '--all', '-i', '-F', ...greps, LOG_FORMAT]))) {
      const named = wanted.filter(k => namesKey(record.body, k))
      if (!named.length) continue
      const known = commits.get(record.sha)
      if (known) known.keys = named
      else commits.set(record.sha, { ...record.commit, cards: [], keys: named })
    }
  }
  return [...commits.values()].sort((a, b) => b.date.localeCompare(a.date))
}

function parseLog(out: string): { sha: string; body: string; commit: Omit<CodeCommit, 'cards' | 'keys'> }[] {
  const records = []
  for (const record of out.split('\x1e')) {
    const fields = record.replace(/^\n/, '').split('\x1f')
    if (fields.length < 6) continue
    const [sha, short, author, date, subject, body] = fields
    records.push({ sha, body, commit: { sha, short, author, date, subject } })
  }
  return records
}

export async function commitFiles(repo: string, sha: string): Promise<{ status: string; file: string }[]> {
  const out = await git(repo, ['show', '--format=', '--name-status', '--no-renames', sha])
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [status, ...rest] = line.split('\t')
      return { status, file: rest.join('\t') }
    })
}

// ---- the code repo panel ----------------------------------------------------------------------

const NETWORK_TIMEOUT_MS = 60_000

/**
 * Reads `git status --porcelain=v2 --branch -z`: the branch, its upstream and the counts. An
 * upstream with no `branch.ab` line is one whose branch is gone from the remote: left out, as
 * though none were set, so Push sets it again.
 */
export function parseStatus(out: string): Omit<RepoStatus, 'repo' | 'remote'> {
  const status: Omit<RepoStatus, 'repo' | 'remote'> = { ahead: 0, behind: 0, changed: 0 }
  let upstream: string | undefined
  let counted = false
  const fields = out.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (field.startsWith('# ')) {
      const [name, ...rest] = field.slice(2).split(' ')
      const value = rest.join(' ')
      if (name === 'branch.oid' && value !== '(initial)') status.head = value.slice(0, 7)
      else if (name === 'branch.head' && value !== '(detached)') status.branch = value
      else if (name === 'branch.upstream') upstream = value
      else if (name === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          status.ahead = Number(m[1])
          status.behind = Number(m[2])
          counted = true
        }
      }
    } else if (/^[12u?] /.test(field)) {
      status.changed++
      // A rename or copy is followed by the path it came from, a field of its own.
      if (field.startsWith('2 ')) i++
    }
  }
  if (upstream && counted) status.upstream = upstream
  return status
}

const config = (repo: string, key: string) => git(repo, ['config', '--get', key]).then(out => out.trim(), () => '')

/** Where the repo stands, or null when the folder is missing or not a git repo. */
export async function repoStatus(repo: string): Promise<RepoStatus | null> {
  if (!existsSync(repo) || !(await isRepo(repo))) return null
  // No optional locks: a status that refreshed the index would wake the watch below, which reads
  // the status again.
  const out = await git(repo, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z'])
  const status: RepoStatus = { repo, ...parseStatus(out) }
  let remote = status.upstream && status.branch ? await config(repo, `branch.${status.branch}.remote`) : ''
  if (!remote) {
    const remotes = (await git(repo, ['remote'])).split('\n').filter(Boolean)
    remote = remotes.includes('origin') ? 'origin' : (remotes[0] ?? '')
  }
  if (remote) status.remote = remote
  return status
}

/**
 * Pushes the branch: to its upstream, or, with none, to the remote, setting it as the upstream
 * (`-u`). The window asks first.
 */
export async function pushRepo(repo: string): Promise<RepoStatus | null> {
  const status = await repoStatus(repo)
  if (!status) throw new Error(`${repo} is not a git repo.`)
  if (!status.branch) throw new Error('HEAD is detached: there is no branch to push.')
  if (!status.remote) throw new Error(`${path.basename(repo)} has no remote to push to.`)
  const merge = status.upstream ? await config(repo, `branch.${status.branch}.merge`) : ''
  const args = merge ? ['push', status.remote, `HEAD:${merge}`] : ['push', '-u', status.remote, status.branch]
  await git(repo, args, NETWORK_TIMEOUT_MS)
  return repoStatus(repo)
}

/**
 * Pulls the branch's upstream, fast-forward only; answers the status after and how many commits
 * came in. A branch that diverged is left as it is, and the error says so.
 */
export async function pullRepo(repo: string): Promise<{ status: RepoStatus | null; pulled: number }> {
  const before = await repoStatus(repo)
  if (!before) throw new Error(`${repo} is not a git repo.`)
  if (!before.branch) throw new Error('HEAD is detached: there is no branch to pull into.')
  if (!before.upstream) throw new Error(`${before.branch} has no upstream to pull from.`)
  const headBefore = before.head ? (await git(repo, ['rev-parse', 'HEAD'])).trim() : ''
  try {
    await git(repo, ['pull', '--no-rebase', '--ff-only'], NETWORK_TIMEOUT_MS)
  } catch (error) {
    const after = await repoStatus(repo).catch(() => null)
    if (after && after.ahead && after.behind) throw new Error(diverged(after))
    throw error
  }
  const range = headBefore ? `${headBefore}..HEAD` : 'HEAD'
  const pulled = Number((await git(repo, ['rev-list', '--count', range])).trim()) || 0
  return { status: await repoStatus(repo), pulled }
}

/** What a branch that diverged from its upstream says. */
export function diverged(status: Pick<RepoStatus, 'branch' | 'upstream' | 'ahead' | 'behind'>): string {
  return `${status.branch} and ${status.upstream} have diverged (${status.ahead} here, ${status.behind} there): merge or rebase it yourself.`
}

/**
 * The code repo of the board in the active tab, watched: its git folder (HEAD, the index, the
 * packed refs) and its refs, so a commit, a checkout or a fetch made anywhere shows within a
 * moment, with no polling. In a worktree `.git` is a file: HEAD lives in the worktree's own git
 * folder and the refs in the common one, so both are watched. One repo at a time: a new tab
 * replaces it. A fetch now and then (when the tab opens and on focus, never more than every few
 * minutes) keeps *behind* meaningful; one that fails (offline, a credential the helper lacks) is
 * not tried again in the background, where it could only fail quietly or prompt.
 */
export class CodeRepoWatch {
  private watchers: FSWatcher[] = []
  private key?: string
  private repo?: string
  private last = ''
  private timer?: NodeJS.Timeout
  private generation = 0
  private fetchedAt = new Map<string, number>()
  private fetchFailed = new Set<string>()

  constructor(
    private onStatus: (key: string, status: RepoStatus | null) => void,
    private fetchEveryMs = 5 * 60_000,
    private debounceMs = 250,
  ) {}

  /** Watches a board's code repo (none: stops watching); answers its status. */
  async watch(key: string | null, repo: string | undefined): Promise<RepoStatus | null> {
    const generation = ++this.generation
    if (!key || !repo) {
      this.stop()
      return null
    }
    if (repo !== this.repo) {
      this.stop()
      this.repo = repo
      const dirs = await gitDirs(repo)
      if (generation !== this.generation) return null
      for (const [dir, recursive] of dirs) {
        try {
          const watcher = watch(dir, { recursive }, () => this.changed())
          watcher.on('error', () => {})
          this.watchers.push(watcher)
        } catch {
          /* a folder gone since: the focus refresh still keeps it current */
        }
      }
    }
    this.key = key
    const status = await repoStatus(repo).catch(() => null)
    if (generation !== this.generation) return null
    this.last = JSON.stringify(status)
    this.fetchIfStale()
    return status
  }

  /** Reads the status again and sends it when it changed; `fetch` first fetches when that's due. */
  refresh(fetch = false): void {
    if (fetch) this.fetchIfStale()
    this.changed()
  }

  stop(): void {
    clearTimeout(this.timer)
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    this.key = undefined
    this.repo = undefined
    this.last = ''
  }

  private changed(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.send(), this.debounceMs)
  }

  private async send(): Promise<void> {
    const { key, repo } = this
    if (!key || !repo) return
    const status = await repoStatus(repo).catch(() => null)
    if (key !== this.key || repo !== this.repo) return
    const text = JSON.stringify(status)
    if (text === this.last) return
    this.last = text
    this.onStatus(key, status)
  }

  private fetchIfStale(): void {
    const repo = this.repo
    if (!repo || this.fetchFailed.has(repo)) return
    if (Date.now() - (this.fetchedAt.get(repo) ?? 0) < this.fetchEveryMs) return
    this.fetchedAt.set(repo, Date.now())
    void (async () => {
      const status = await repoStatus(repo).catch(() => null)
      if (!status?.upstream || !status.remote) return
      // The refs it brings wake the watch, which sends the status.
      await git(repo, ['fetch', '--quiet', status.remote], NETWORK_TIMEOUT_MS).catch(() => this.fetchFailed.add(repo))
    })()
  }
}

/** The folders a repo's HEAD and refs live in, each with whether it is watched recursively. */
async function gitDirs(repo: string): Promise<[string, boolean][]> {
  try {
    const out = await git(repo, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
    const [own, common] = out.split('\n').map(l => l.trim())
    const dirs: [string, boolean][] = [[own, false]]
    if (common && common !== own) dirs.push([common, false])
    dirs.push([path.join(common || own, 'refs'), true])
    return dirs
  } catch {
    return []
  }
}

/**
 * Commits the board repo a few seconds after the last change, one commit per quiet spell,
 * with a message that says what moved.
 */
export class AutoCommitter {
  private timer?: NodeJS.Timeout
  /** The commit under way, which a flush waits for. */
  private current?: Promise<string | undefined>

  constructor(
    private root: string,
    private delayMs: number,
    private onCommitted: (summary: string) => void,
  ) {}

  touch(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), this.delayMs)
  }

  /**
   * Commits what is pending now. A commit already under way may have staged before the latest
   * writes, so this waits for it and then commits what is left: once it resolves, everything
   * written before the call is committed (or the commit failed, and a retry is scheduled). The
   * sync relies on that: it must not rebase over changes still waiting for a commit.
   */
  async flush(): Promise<string | undefined> {
    clearTimeout(this.timer)
    while (this.current) await this.current
    this.current = this.commit().finally(() => (this.current = undefined))
    return this.current
  }

  private async commit(): Promise<string | undefined> {
    try {
      if (!(await isRepo(this.root))) return undefined
      const status = await git(this.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      if (!status) return undefined
      await git(this.root, ['add', '-A'])
      const lines = await this.describe()
      if (!lines.length) return undefined
      const subject = lines.length === 1 ? lines[0] : `Board: ${lines.length} changes`
      const args = ['commit', '-q', '-m', subject]
      if (lines.length > 1) {
        const shown = lines.slice(0, 40)
        if (lines.length > shown.length) shown.push(`… and ${lines.length - shown.length} more`)
        args.push('-m', shown.join('\n'))
      }
      await git(this.root, args)
      this.onCommitted(subject)
      return subject
    } catch (error) {
      // Another git process (a session that committed anyway) holds the lock: try again later.
      console.warn('[corkboard] board auto-commit failed:', (error as Error).message)
      this.touch()
      return undefined
    }
  }

  /** One line per staged file, read off the staged diff against HEAD. */
  private async describe(): Promise<string[]> {
    const out = await git(this.root, ['diff', '--cached', '--name-status', '--no-renames', '-z'])
    const parts = out.split('\0').filter(Boolean)
    const lines: string[] = []
    const hasHead = await git(this.root, ['rev-parse', '--verify', '-q', 'HEAD']).then(
      () => true,
      () => false,
    )
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]
      const file = parts[i + 1]
      const name = path.posix.basename(file)
      const dir = path.posix.dirname(file)
      const imageOf = cardImageOf(file)
      if (imageOf) {
        lines.push(status === 'A' ? `Add an image to ${imageOf}` : status === 'D' ? `Remove an image from ${imageOf}` : `Edit an image of ${imageOf}`)
      } else if (name.endsWith('.md') && path.posix.basename(dir) === 'cards') {
        const id = name.slice(0, -3)
        if (status === 'D') {
          lines.push(`Remove ${id}`)
          continue
        }
        const now = tryParseCard(await fs.readFile(path.join(this.root, file), 'utf8'), id)
        if (status === 'A' || !hasHead) {
          lines.push(now ? `Add ${id}: ${now.title}` : `Add ${id}`)
          continue
        }
        const before = tryParseCard(await git(this.root, ['show', `HEAD:${file}`]).catch(() => ''), id)
        // A card saved half-way is committed all the same: one unreadable file must not stop
        // every commit (and push) after it.
        if (!now || !before) lines.push(`Edit ${id}`)
        else if (before.list !== now.list) lines.push(`Move ${id}: ${before.list ?? 'map'} → ${now.list ?? 'map'}`)
        else if (!before.archived && now.archived) lines.push(`Archive ${id}`)
        else if (now.sessions.length > before.sessions.length) {
          const last = now.sessions.at(-1)
          const kind = last?.kind === 'cloud' ? ' in Claude Cloud' : ''
          lines.push(`${last?.purpose === 'discuss' ? 'Discuss' : 'Tackle'} ${id}${kind}`)
        } else if (now.sessions.length < before.sessions.length) {
          const gone = before.sessions.length - now.sessions.length
          lines.push(`Forget ${gone} session${gone === 1 ? '' : 's'} on ${id}`)
        }
        else if (before.title !== now.title) lines.push(`Rename ${id}: ${now.title}`)
        else if (before.links.join() !== now.links.join()) {
          const added = now.links.filter(l => !before.links.includes(l))
          const gone = before.links.filter(l => !now.links.includes(l))
          if (added.length) lines.push(`Link ${id} to ${added.join(', ')}`)
          if (gone.length) lines.push(`Unlink ${id} from ${gone.join(', ')}`)
        }
        else if (before.pos !== now.pos && before.body === now.body) lines.push(`Reorder ${id}`)
        else lines.push(`Edit ${id}`)
      } else if (name === 'board.json') {
        lines.push(`${status === 'A' ? 'Create' : status === 'D' ? 'Delete' : 'Edit'} board ${dir}`)
      } else if (name === 'map.json') {
        lines.push(`Arrange map of ${dir}`)
      } else if (file === THEME_FILE) {
        lines.push(`${status === 'A' ? 'Add' : status === 'D' ? 'Remove' : 'Edit'} the project's theme`)
      } else if (file === PROJECT_FILE) {
        // Say which setting changed, and which way, when it is one this app knows.
        const now = status === 'D' ? {} : parseProjectSettings(await fs.readFile(path.join(this.root, file), 'utf8'))
        const before = status === 'A' || !hasHead ? '{}' : await git(this.root, ['show', `HEAD:${file}`]).catch(() => '')
        const was = parseProjectSettings(before)
        const said = lines.length
        if (now && was && !!now.work !== !!was.work) lines.push(`Turn work mode ${now.work ? 'on' : 'off'}`)
        if (now && was && now.board !== was.board && now.board) lines.push(`Make ${now.board} the main board`)
        if (now && was && now.icon !== was.icon) lines.push(now.icon ? "Set the project's icon" : "Remove the project's icon")
        if (lines.length === said) lines.push(`${status === 'A' ? 'Add' : status === 'D' ? 'Remove' : 'Edit'} the project's settings`)
      } else {
        lines.push(`${status === 'A' ? 'Add' : status === 'D' ? 'Remove' : 'Edit'} ${file}`)
      }
    }
    return lines
  }
}
