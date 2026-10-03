import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AutoCommitter, codeCommits, git } from '../src/main/git'
import { BoardStore } from '../src/main/store'
import { parseCard, serializeCard } from '@shared/cardfile'
import type { BoardDelta } from '@shared/types'

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'corkboard-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function until<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await sleep(25)
  }
}

describe('BoardStore', () => {
  it('creates nested boards and builds the tree with inherited code repos', async () => {
    const store = new BoardStore(root)
    await store.init()
    const parent = await store.createBoard('', 'Robot shooter', 'RS')
    await store.updateMeta(parent, { codeRepo: '/code' })
    const child = await store.createBoard(parent, 'Ideas')
    const other = await store.createBoard('', 'Robot shooter', 'RS')

    expect(parent).toBe('robot-shooter')
    expect(child).toBe('robot-shooter/ideas')
    expect(other).toBe('robot-shooter-2')
    expect(store.board(other).meta.key).toBe('RS2')
    expect(store.board(child).codeRepo).toBe('/code')

    const fresh = new BoardStore(root)
    await fresh.init()
    const tree = fresh.tree()
    expect(tree.map(n => n.path)).toEqual(['robot-shooter', 'robot-shooter-2'])
    expect(tree[0].children.map(n => n.path)).toEqual(['robot-shooter/ideas'])
    expect(fresh.board('robot-shooter/ideas').codeRepo).toBe('/code')
  })

  it('numbers cards per board and writes them as files', async () => {
    const store = new BoardStore(root)
    await store.init()
    const p = await store.createBoard('', 'Game', 'G')
    const a = await store.createCard(p, { title: 'First', list: 'todo' })
    const b = await store.createCard(p, { title: 'Second', list: 'todo' })
    const idea = await store.createCard(p, { title: 'An idea', list: null })
    expect([a.id, b.id, idea.id]).toEqual(['G-1', 'G-2', 'G-3'])
    expect(b.pos).toBeGreaterThan(a.pos)
    const file = readFileSync(store.cardFile(p, 'G-2'), 'utf8')
    expect(parseCard(file).title).toBe('Second')
    const moved = await store.updateCard(p, 'G-2', { list: 'done' })
    expect(moved.list).toBe('done')
    expect(parseCard(readFileSync(store.cardFile(p, 'G-2'), 'utf8')).list).toBe('done')
  })

  it('refuses to delete a board that still has cards', async () => {
    const store = new BoardStore(root)
    await store.init()
    const p = await store.createBoard('', 'Game', 'G')
    await store.createCard(p, { title: 'x', list: 'todo' })
    await expect(store.deleteBoard(p)).rejects.toThrow(/cards/)
    const empty = await store.createBoard('', 'Empty', 'E')
    await store.deleteBoard(empty)
    expect(store.tree().map(n => n.path)).toEqual(['game'])
  })

  it('sees a card edited, added and removed on disk by someone else', async () => {
    const store = new BoardStore(root)
    await store.init()
    const p = await store.createBoard('', 'Game', 'G')
    const card = await store.createCard(p, { title: 'Move me', list: 'todo' })
    const deltas: BoardDelta[] = []
    let treeChanges = 0
    store.watch({ onDelta: d => deltas.push(d), onTreeChanged: () => treeChanges++ })
    await sleep(100)

    // A Claude session moves the card by editing its front matter.
    writeFileSync(store.cardFile(p, card.id), serializeCard({ ...card, list: 'done' }))
    const moved = await until(() => deltas.find(d => d.cards.some(c => c.id === card.id && c.list === 'done')))
    expect(moved.path).toBe(p)
    expect(store.board(p).cards.find(c => c.id === card.id)?.list).toBe('done')

    // ...adds one...
    writeFileSync(store.cardFile(p, 'G-7'), '---\nid: G-7\ntitle: Written by hand\nlist: todo\npos: 5\n---\n')
    await until(() => deltas.find(d => d.cards.some(c => c.id === 'G-7')))
    expect(treeChanges).toBeGreaterThan(0)

    // ...and removes one.
    rmSync(store.cardFile(p, 'G-7'))
    await until(() => deltas.find(d => d.removed.includes('G-7')))
    expect(store.board(p).cards.map(c => c.id)).toEqual([card.id])
    store.close()
  })

  it('drops the watch echo of its own writes', async () => {
    const store = new BoardStore(root)
    await store.init()
    const p = await store.createBoard('', 'Game', 'G')
    const deltas: BoardDelta[] = []
    store.watch({ onDelta: d => deltas.push(d), onTreeChanged: () => {} })
    await sleep(100)
    await store.createCard(p, { title: 'Mine', list: 'todo' })
    await sleep(400)
    // One delta from the write itself, none from the watch.
    expect(deltas.length).toBe(1)
    store.close()
  })
})

describe('git', () => {
  it('auto-commits the board with a message that says what moved', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
    const store = new BoardStore(root)
    await store.init()
    const p = await store.createBoard('', 'Game', 'G')
    await store.createCard(p, { title: 'Ship it', list: 'todo' })
    const committed: string[] = []
    const committer = new AutoCommitter(root, 10, s => committed.push(s))
    expect(await committer.flush()).toBe('Board: 2 changes')

    await store.updateCard(p, 'G-1', { list: 'done' })
    expect(await committer.flush()).toBe('Move G-1: todo → done')
    await store.updateCard(p, 'G-1', { archived: true })
    expect(await committer.flush()).toBe('Archive G-1')
    expect(await committer.flush()).toBeUndefined()
    const log = await git(root, ['log', '--format=%s'])
    expect(log.trim().split('\n')).toEqual(['Archive G-1', 'Move G-1: todo → done', 'Board: 2 changes'])
    expect(committed.length).toBe(3)
  })

  it('reads Card trailers from every branch of a code repo', async () => {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: root })
    run('init', '-q', '-b', 'main')
    run('config', 'user.email', 't@example.com')
    run('config', 'user.name', 'Test')
    run('commit', '-q', '--allow-empty', '-m', 'Unrelated')
    run('commit', '-q', '--allow-empty', '-m', 'Fix the eye attack\n\nCard: RS-12')
    run('checkout', '-q', '-b', 'card/rs-20')
    run('commit', '-q', '--allow-empty', '-m', 'Two at once\n\nCard: rs-20, RS-21\nCo-Authored-By: x <y@z>')
    const commits = await codeCommits(root)
    expect(commits.map(c => [c.subject, c.cards])).toEqual([
      ['Two at once', ['RS-20', 'RS-21']],
      ['Fix the eye attack', ['RS-12']],
    ])
  })
})
