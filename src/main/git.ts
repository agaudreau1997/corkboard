// Git, both ways: the board repo is committed by the app after every quiet spell, and a board's
// code repo is read for the commits whose `Card:` trailers name its cards.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseCard } from '@shared/cardfile'
import type { CodeCommit } from '@shared/types'

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

/** Every commit on any branch whose message names a card with a `Card:` line. */
export async function codeCommits(repo: string): Promise<CodeCommit[]> {
  const out = await git(repo, [
    'log',
    '--all',
    '-i',
    '--grep=^Card:',
    '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%B%x1e',
  ])
  const commits: CodeCommit[] = []
  for (const record of out.split('\x1e')) {
    const fields = record.replace(/^\n/, '').split('\x1f')
    if (fields.length < 6) continue
    const [sha, short, author, date, subject, body] = fields
    const cards = new Set<string>()
    for (const m of body.matchAll(CARD_TRAILER)) {
      for (const id of m[1].split(/[,\s]+/)) if (id) cards.add(id.trim().toUpperCase())
    }
    if (cards.size) commits.push({ sha, short, author, date, subject, cards: [...cards] })
  }
  return commits
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

/**
 * Commits the board repo a few seconds after the last change, one commit per quiet spell,
 * with a message that says what moved.
 */
export class AutoCommitter {
  private timer?: NodeJS.Timeout
  private running = false
  private again = false

  constructor(
    private root: string,
    private delayMs: number,
    private onCommitted: (summary: string) => void,
  ) {}

  touch(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), this.delayMs)
  }

  async flush(): Promise<string | undefined> {
    clearTimeout(this.timer)
    if (this.running) {
      this.again = true
      return undefined
    }
    this.running = true
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
    } finally {
      this.running = false
      if (this.again) {
        this.again = false
        this.touch()
      }
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
      if (name.endsWith('.md') && path.posix.basename(dir) === 'cards') {
        const id = name.slice(0, -3)
        if (status === 'D') {
          lines.push(`Remove ${id}`)
          continue
        }
        const now = parseCard(await fs.readFile(path.join(this.root, file), 'utf8'), id)
        if (status === 'A' || !hasHead) {
          lines.push(`Add ${id}: ${now.title}`)
          continue
        }
        const before = parseCard(await git(this.root, ['show', `HEAD:${file}`]).catch(() => ''), id)
        if (before.list !== now.list) lines.push(`Move ${id}: ${before.list ?? 'map'} → ${now.list ?? 'map'}`)
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
      } else {
        lines.push(`${status === 'A' ? 'Add' : status === 'D' ? 'Remove' : 'Edit'} ${file}`)
      }
    }
    return lines
  }
}
