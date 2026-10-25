// The code repo panel's git: the status it reads, and push and pull against a scratch bare remote.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RepoStatus } from '@shared/types'
import { CodeRepoWatch, parseStatus, pullRepo, pushRepo, repoStatus } from '../src/main/git'

describe('parseStatus', () => {
  it('reads the branch, its upstream and how far apart they are', () => {
    const out = ['# branch.oid 0123456789abcdef', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1', ''].join('\0')
    expect(parseStatus(out)).toEqual({ head: '0123456', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, changed: 0 })
  })

  it('counts changed, unmerged and untracked files, a rename once', () => {
    const out = [
      '# branch.oid 0123456789abcdef',
      '# branch.head feature/x',
      '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 src/new name.ts',
      'src/old name.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/c.ts',
      '? notes.txt',
      '',
    ].join('\0')
    const status = parseStatus(out)
    expect(status.changed).toBe(4)
    expect(status.branch).toBe('feature/x')
    expect(status.upstream).toBeUndefined()
  })

  it('a detached HEAD has no branch; a repo with no commit no head', () => {
    expect(parseStatus('# branch.oid 0123456789\0# branch.head (detached)\0')).toEqual({ head: '0123456', ahead: 0, behind: 0, changed: 0 })
    expect(parseStatus('# branch.oid (initial)\0# branch.head main\0')).toEqual({ branch: 'main', ahead: 0, behind: 0, changed: 0 })
  })

  it('an upstream whose branch is gone counts as none', () => {
    const out = '# branch.oid 0123456789\0# branch.head main\0# branch.upstream origin/main\0'
    expect(parseStatus(out).upstream).toBeUndefined()
  })
})

describe('push and pull', () => {
  let dir: string
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd }).toString()
  const commit = (cwd: string, message: string) => run(cwd, '-c', 'user.email=e@x', '-c', 'user.name=E', 'commit', '-q', '--allow-empty', '-m', message)

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'corkboard-repo-'))
    run(dir, 'init', '-q', '--bare', '-b', 'main', 'remote.git')
    run(dir, 'init', '-q', '-b', 'main', 'code')
    commit(path.join(dir, 'code'), 'First')
    run(path.join(dir, 'code'), 'remote', 'add', 'origin', path.join(dir, 'remote.git'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a missing folder or one that is not a repo has no status', async () => {
    expect(await repoStatus(path.join(dir, 'nowhere'))).toBeNull()
    expect(await repoStatus(path.join(dir, 'remote.git'))).toBeNull()
  })

  it('pushes a branch with no upstream to origin and sets it, then counts what is ahead', async () => {
    const code = path.join(dir, 'code')
    writeFileSync(path.join(code, 'new.txt'), 'x')
    const before = await repoStatus(code)
    expect(before).toMatchObject({ branch: 'main', remote: 'origin', changed: 1 })
    expect(before).not.toHaveProperty('upstream')
    const pushed = await pushRepo(code)
    expect(pushed).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 })
    commit(code, 'Second')
    expect(await repoStatus(code)).toMatchObject({ ahead: 1 })
    expect(await pushRepo(code)).toMatchObject({ ahead: 0 })
    expect(run(dir, '--git-dir=remote.git', 'log', '--format=%s', 'main')).toBe('Second\nFirst\n')
    // Nothing was committed: the untracked file is still there, uncommitted.
    expect((await repoStatus(code))?.changed).toBe(1)
  })

  it('pulls fast-forward only, and says so when the branch diverged', async () => {
    const code = path.join(dir, 'code')
    await pushRepo(code)
    run(dir, 'clone', '-q', path.join(dir, 'remote.git'), 'other')
    const other = path.join(dir, 'other')
    commit(other, 'From the other machine')
    run(other, 'push', '-q')
    expect(await pullRepo(code)).toMatchObject({ pulled: 1, status: { ahead: 0, behind: 0 } })

    commit(other, 'There')
    run(other, 'push', '-q')
    commit(code, 'Here')
    await expect(pullRepo(code)).rejects.toThrow(/main and origin\/main have diverged \(1 here, 1 there\)/)
    expect(run(code, 'log', '-1', '--format=%s')).toBe('Here\n')
  })

  it('a branch with no upstream has nothing to pull', async () => {
    await expect(pullRepo(path.join(dir, 'code'))).rejects.toThrow(/no upstream/)
  })

  it('the watch sees a commit made in a worktree of the repo', async () => {
    const code = path.join(dir, 'code')
    await pushRepo(code)
    const tree = path.join(dir, 'tree')
    run(code, 'worktree', 'add', '-q', '-b', 'side', tree)
    const seen: (RepoStatus | null)[] = []
    const watch = new CodeRepoWatch((_key, status) => seen.push(status), Infinity, 50)
    try {
      expect(await watch.watch('p:board', tree)).toMatchObject({ branch: 'side', ahead: 0 })
      run(tree, 'branch', '-q', '--set-upstream-to=origin/main')
      commit(tree, 'In the worktree')
      const end = Date.now() + 5000
      while (!seen.some(s => s?.ahead === 1) && Date.now() < end) await new Promise(r => setTimeout(r, 50))
      expect(seen.at(-1)).toMatchObject({ branch: 'side', upstream: 'origin/main', ahead: 1 })
    } finally {
      watch.stop()
    }
  })
})
