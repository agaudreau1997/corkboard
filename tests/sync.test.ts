// Two clones of one bare remote stand in for two machines.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCard, serializeCard } from '@shared/cardfile'
import type { Card, SyncStatus } from '@shared/types'
import { AutoCommitter } from '../src/main/git'
import { BoardSync, mergeBoards, mergeMaps, newerCard } from '../src/main/sync'

let dir: string
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd }).toString()

function card(id: string, list: string, updated: string, title = id): Card {
  return { id, title, list, pos: 1024, updated, labels: [], links: [], after: [], sessions: [], body: '', extra: {} }
}

function clone(name: string): string {
  const at = path.join(dir, name)
  // Files as written, whatever this machine's git does with line endings (Git for Windows
  // checks out CRLF by default).
  run(dir, 'clone', '-q', '-c', 'core.autocrlf=false', path.join(dir, 'remote.git'), at)
  run(at, 'config', 'user.email', `${name}@example.com`)
  run(at, 'config', 'user.name', name)
  return at
}

function machine(root: string) {
  const committer = new AutoCommitter(root, 10_000, () => {})
  const sync = new BoardSync(root, committer, () => {}, 0)
  return { root, committer, sync, file: (rel: string) => path.join(root, rel) }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'corkboard-sync-'))
  run(dir, 'init', '-q', '--bare', '-b', 'main', 'remote.git')
  const seed = clone('seed')
  mkdirSync(path.join(seed, 'game/cards'), { recursive: true })
  writeFileSync(path.join(seed, 'game/board.json'), JSON.stringify({ key: 'G', title: 'Game', lists: [{ id: 'todo', title: 'To do' }, { id: 'done', title: 'Done' }] }, null, 2) + '\n')
  writeFileSync(path.join(seed, 'game/map.json'), JSON.stringify({ nodes: { 'G-1': { x: 0, y: 0 } } }, null, 2) + '\n')
  writeFileSync(path.join(seed, 'game/cards/G-1.md'), serializeCard(card('G-1', 'todo', '2026-10-01T10:00:00.000Z')))
  writeFileSync(path.join(seed, 'README.md'), 'hello\n')
  run(seed, 'add', '-A')
  run(seed, 'commit', '-q', '-m', 'seed')
  run(seed, 'push', '-q', 'origin', 'main')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('BoardSync', () => {
  it('pushes one machine’s change and pulls it on the other', async () => {
    const a = machine(clone('a'))
    const b = machine(clone('b'))
    writeFileSync(a.file('game/cards/G-1.md'), serializeCard(card('G-1', 'done', '2026-10-02T10:00:00.000Z')))
    const pushed = await a.sync.sync()
    expect(pushed.state).toBe('synced')
    expect(pushed.pushed).toBe(1)

    const pulled = await b.sync.sync()
    expect(pulled).toMatchObject({ state: 'synced', pulled: 1, pushed: 0 })
    expect(parseCard(readFileSync(b.file('game/cards/G-1.md'), 'utf8')).list).toBe('done')
  })

  it('keeps the card edited last when both machines changed it', async () => {
    const a = machine(clone('a'))
    const b = machine(clone('b'))
    // A moved it to done at 11:00 and synced; B, offline, renamed it at 12:00.
    writeFileSync(a.file('game/cards/G-1.md'), serializeCard(card('G-1', 'done', '2026-10-02T11:00:00.000Z')))
    await a.sync.sync()
    writeFileSync(b.file('game/cards/G-1.md'), serializeCard(card('G-1', 'todo', '2026-10-02T12:00:00.000Z', 'Renamed on B')))
    const status = await b.sync.sync()
    expect(status.state).toBe('synced')
    const merged = parseCard(readFileSync(b.file('game/cards/G-1.md'), 'utf8'))
    expect(merged.title).toBe('Renamed on B')

    await a.sync.sync()
    expect(parseCard(readFileSync(a.file('game/cards/G-1.md'), 'utf8')).title).toBe('Renamed on B')
    expect(run(a.root, 'status', '--porcelain')).toBe('')
  })

  it('commits a write that lands mid-sync before rebasing over the same card', async () => {
    const a = machine(clone('a'))
    const b = machine(clone('b'))
    const g1 = (m: typeof a) => m.file('game/cards/G-1.md')
    // A moved the card at 12:00 and synced. B renamed it at 11:00 (the sync commits that), and
    // at 12:10, while the sync fetched, moved it again (a drag, a session recorded on it).
    writeFileSync(g1(a), serializeCard(card('G-1', 'done', '2026-10-02T12:00:00.000Z', 'Moved on A')))
    await a.sync.sync()
    writeFileSync(g1(b), serializeCard(card('G-1', 'todo', '2026-10-02T11:00:00.000Z', 'Renamed on B')))
    const flush = b.committer.flush.bind(b.committer)
    let late = true
    b.committer.flush = async () => {
      const out = await flush()
      if (late) {
        late = false
        writeFileSync(g1(b), serializeCard(card('G-1', 'doing', '2026-10-02T12:10:00.000Z', 'Renamed on B')))
      }
      return out
    }
    const status = await b.sync.sync()
    const text = readFileSync(g1(b), 'utf8')
    expect(text).not.toContain('<<<<<<<')
    expect(parseCard(text)).toMatchObject({ list: 'doing', title: 'Renamed on B' })
    expect(status.state).toBe('synced')
    expect(run(b.root, 'status', '--porcelain')).toBe('')
  })

  it('flush syncs after the one under way, so a write made meanwhile is pushed', async () => {
    const a = machine(clone('a'))
    // A sync is under way, its commit done, when a card is written and the app quits. sync() would
    // hand back the running one, which committed before the write, and since the quit stopped the
    // syncer, the round it queues would never come.
    const commit = a.committer.flush.bind(a.committer)
    let flushed: Promise<SyncStatus> | undefined
    a.committer.flush = async () => {
      const out = await commit()
      if (!flushed) {
        writeFileSync(a.file('game/cards/G-1.md'), serializeCard(card('G-1', 'done', '2026-10-02T12:00:00.000Z', 'Written at quit')))
        a.sync.stop()
        flushed = a.sync.flush()
      }
      return out
    }
    expect(await a.sync.sync()).toMatchObject({ state: 'synced', pushed: 0 })
    expect(await flushed!).toMatchObject({ state: 'synced', pushed: 1 })
    expect(run(path.join(dir, 'remote.git'), 'show', 'main:game/cards/G-1.md')).toContain('Written at quit')
  })

  it('keeps both cards when both machines made one under the same id, renumbering this one', async () => {
    const a = machine(clone('a'))
    const b = machine(clone('b'))
    const made = (m: typeof a, uid: string, title: string, updated: string) =>
      writeFileSync(m.file('game/cards/G-2.md'), serializeCard({ ...card('G-2', 'todo', updated, title), uid, created: updated }))
    made(a, 'uid-a', 'Made on A', '2026-10-02T10:00:00.000Z')
    await a.sync.sync()

    // B, offline, made its own G-2 (with an image), linked G-1 to it, placed it on the map, and
    // later edited it again: three commits that all name it.
    made(b, 'uid-b', 'Made on B', '2026-10-02T11:00:00.000Z')
    mkdirSync(b.file('game/cards/G-2'))
    writeFileSync(b.file('game/cards/G-2/0123456789abcdef.png'), 'png')
    run(b.root, 'add', '-A')
    run(b.root, 'commit', '-q', '-m', 'Add G-2: Made on B')
    writeFileSync(b.file('game/cards/G-1.md'), serializeCard({ ...card('G-1', 'todo', '2026-10-02T11:30:00.000Z'), links: ['G-2'], after: ['G-2'] }))
    writeFileSync(b.file('game/map.json'), JSON.stringify({ nodes: { 'G-1': { x: 0, y: 0 }, 'G-2': { x: 7, y: 7 } } }, null, 2) + '\n')
    run(b.root, 'commit', '-q', '-am', 'Link G-1 to G-2')
    writeFileSync(
      b.file('game/cards/G-2.md'),
      serializeCard({
        ...card('G-2', 'done', '2026-10-02T12:00:00.000Z', 'Made on B'),
        uid: 'uid-b',
        created: '2026-10-02T11:00:00.000Z',
        body: '![](G-2/0123456789abcdef.png)',
        cover: 'G-2/0123456789abcdef.png',
      }),
    )
    const status = await b.sync.sync()
    expect(status.state).toBe('synced')
    expect(status.renumbered).toEqual([{ board: 'game', from: 'G-2', to: 'G-3', uid: 'uid-b', at: expect.any(String) }])

    const kept = parseCard(readFileSync(b.file('game/cards/G-2.md'), 'utf8'))
    expect(kept).toMatchObject({ title: 'Made on A', uid: 'uid-a' })
    const moved = parseCard(readFileSync(b.file('game/cards/G-3.md'), 'utf8'))
    expect(moved).toMatchObject({
      id: 'G-3',
      title: 'Made on B',
      uid: 'uid-b',
      list: 'done',
      body: '![](G-3/0123456789abcdef.png)',
      cover: 'G-3/0123456789abcdef.png',
    })
    expect(moved.renumbered).toEqual([{ from: 'G-2', at: status.renumbered![0].at }])
    expect(moved.updated).toBe(status.renumbered![0].at)
    expect(readFileSync(b.file('game/cards/G-3/0123456789abcdef.png'), 'utf8')).toBe('png')
    expect(existsSync(b.file('game/cards/G-2'))).toBe(false)
    expect(parseCard(readFileSync(b.file('game/cards/G-1.md'), 'utf8'))).toMatchObject({ links: ['G-3'], after: ['G-3'] })
    expect(JSON.parse(readFileSync(b.file('game/map.json'), 'utf8')).nodes['G-3']).toEqual({ x: 7, y: 7 })
    expect(run(b.root, 'status', '--porcelain')).toBe('')
    // B's commits never had its card under the id A's has.
    expect(run(b.root, 'log', '--format=%s', '-1')).toBe('Renumber G-2 as G-3\n')
    expect(run(b.root, 'log', '--format=', '--name-only', 'origin/main~4..origin/main')).not.toContain('G-2.md')

    // The status names it until the window dismisses it.
    expect((await b.sync.sync()).renumbered).toHaveLength(1)
    b.sync.dismissRenumbered()
    expect(b.sync.status.renumbered).toBeUndefined()

    await a.sync.sync()
    expect(parseCard(readFileSync(a.file('game/cards/G-2.md'), 'utf8')).title).toBe('Made on A')
    expect(parseCard(readFileSync(a.file('game/cards/G-3.md'), 'utf8')).title).toBe('Made on B')
  })

  it('tells two cards made under one id without uids apart by when they were made', async () => {
    const a = machine(clone('a'))
    const b = machine(clone('b'))
    const made = (m: typeof a, title: string, created: string) =>
      writeFileSync(m.file('game/cards/G-2.md'), serializeCard({ ...card('G-2', 'todo', created, title), created }))
    made(a, 'Made on A', '2026-10-02T10:00:00.000Z')
    await a.sync.sync()
    made(b, 'Made on B', '2026-10-02T11:00:00.000Z')
    const status = await b.sync.sync()
    expect(status).toMatchObject({ state: 'synced', renumbered: [{ from: 'G-2', to: 'G-3' }] })
    expect(parseCard(readFileSync(b.file('game/cards/G-2.md'), 'utf8')).title).toBe('Made on A')
    expect(parseCard(readFileSync(b.file('game/cards/G-3.md'), 'utf8')).title).toBe('Made on B')
  })

  it('keeps one card, the newer, when both sides added the same card', async () => {
    const a = machine(clone('a'))
    const b = machine(clone('b'))
    // One uid on both sides: a card copied in by hand on each, say.
    const same = (m: typeof a, updated: string, title: string) =>
      writeFileSync(m.file('game/cards/G-2.md'), serializeCard({ ...card('G-2', 'todo', updated, title), uid: 'one' }))
    same(a, '2026-10-02T10:00:00.000Z', 'Older')
    await a.sync.sync()
    same(b, '2026-10-02T11:00:00.000Z', 'Newer')
    const status = await b.sync.sync()
    expect(status.state).toBe('synced')
    expect(status.renumbered).toBeUndefined()
    expect(parseCard(readFileSync(b.file('game/cards/G-2.md'), 'utf8')).title).toBe('Newer')
    expect(existsSync(b.file('game/cards/G-3.md'))).toBe(false)
  })

  it('keeps one card when both machines gave it a uid before syncing', async () => {
    const a = machine(clone('a'))
    const b = machine(clone('b'))
    const withUid = (m: typeof a, uid: string) => {
      const text = readFileSync(m.file('game/cards/G-1.md'), 'utf8')
      writeFileSync(m.file('game/cards/G-1.md'), serializeCard({ ...parseCard(text), uid }))
    }
    withUid(a, 'uid-a')
    await a.sync.sync()
    withUid(b, 'uid-b')
    const status = await b.sync.sync()
    expect(status.state).toBe('synced')
    expect(status.renumbered).toBeUndefined()
    expect(run(b.root, 'ls-files', 'game/cards')).toBe('game/cards/G-1.md\n')
    await a.sync.sync()
    const uid = (m: typeof a) => parseCard(readFileSync(m.file('game/cards/G-1.md'), 'utf8')).uid
    expect(uid(a)).toBe(uid(b))
  })

  it('waits rather than rebase over a change it could not commit', async () => {
    const a = machine(clone('a'))
    const b = machine(clone('b'))
    writeFileSync(a.file('game/cards/G-1.md'), serializeCard(card('G-1', 'done', '2026-10-02T12:00:00.000Z')))
    await a.sync.sync()
    // Something holds the board repo (a git process of its own): B's change stays uncommitted.
    b.committer.flush = async () => undefined
    const mine = serializeCard(card('G-1', 'todo', '2026-10-02T12:10:00.000Z', 'Not committed yet'))
    writeFileSync(b.file('game/cards/G-1.md'), mine)
    const status = await b.sync.sync()
    b.sync.stop()
    expect(status.state).toBe('syncing')
    expect(readFileSync(b.file('game/cards/G-1.md'), 'utf8')).toBe(mine)
    expect(run(b.root, 'rev-list', '--count', 'HEAD..origin/main').trim()).toBe('1')
  })

  it('merges map positions and lists from both sides', async () => {
    const a = machine(clone('a'))
    const b = machine(clone('b'))
    writeFileSync(a.file('game/map.json'), JSON.stringify({ nodes: { 'G-1': { x: 0, y: 0 }, 'G-2': { x: 5, y: 5 } } }) + '\n')
    const metaA = JSON.parse(readFileSync(a.file('game/board.json'), 'utf8'))
    metaA.lists.push({ id: 'ideas', title: 'Ideas' })
    writeFileSync(a.file('game/board.json'), JSON.stringify(metaA, null, 2) + '\n')
    await a.sync.sync()

    writeFileSync(b.file('game/map.json'), JSON.stringify({ nodes: { 'G-1': { x: 9, y: 9 }, 'G-3': { x: 1, y: 1 } } }) + '\n')
    const metaB = JSON.parse(readFileSync(b.file('game/board.json'), 'utf8'))
    metaB.lists.push({ id: 'bugs', title: 'Bugs' })
    writeFileSync(b.file('game/board.json'), JSON.stringify(metaB, null, 2) + '\n')
    expect((await b.sync.sync()).state).toBe('synced')

    const map = JSON.parse(readFileSync(b.file('game/map.json'), 'utf8'))
    expect(map.nodes).toEqual({ 'G-1': { x: 9, y: 9 }, 'G-2': { x: 5, y: 5 }, 'G-3': { x: 1, y: 1 } })
    const lists = JSON.parse(readFileSync(b.file('game/board.json'), 'utf8')).lists.map((l: { id: string }) => l.id)
    expect(lists).toEqual(['todo', 'done', 'ideas', 'bugs'])
  })

  it("keeps this machine's theme when both changed it", async () => {
    const a = machine(clone('a'))
    const b = machine(clone('b'))
    writeFileSync(a.file('theme.json'), '{ "name": "Moss", "colors": { "accent": "#8fcf7a" } }\n')
    await a.sync.sync()
    writeFileSync(b.file('theme.json'), '{ "name": "Tide", "colors": { "accent": "#5ec4d6" } }\n')
    expect((await b.sync.sync()).state).toBe('synced')
    expect(JSON.parse(readFileSync(b.file('theme.json'), 'utf8')).name).toBe('Tide')
    expect((await a.sync.sync()).state).toBe('synced')
    expect(JSON.parse(readFileSync(a.file('theme.json'), 'utf8')).name).toBe('Tide')
  })

  it("keeps this machine's image when both added one of the same name, and both sides' others", async () => {
    const a = machine(clone('a'))
    const b = machine(clone('b'))
    mkdirSync(a.file('game/cards/G-1'))
    mkdirSync(b.file('game/cards/G-1'))
    const png = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0xff, n, 0x00, 0x80])
    writeFileSync(a.file('game/cards/G-1/shot.png'), png(1))
    writeFileSync(a.file('game/cards/G-1/same.png'), png(7))
    writeFileSync(a.file('game/cards/G-1/only-a.png'), png(2))
    await a.sync.sync()
    writeFileSync(b.file('game/cards/G-1/shot.png'), png(3))
    writeFileSync(b.file('game/cards/G-1/same.png'), png(7))
    expect((await b.sync.sync()).state).toBe('synced')
    expect(readFileSync(b.file('game/cards/G-1/shot.png'))).toEqual(png(3))
    expect(readFileSync(b.file('game/cards/G-1/only-a.png'))).toEqual(png(2))
    expect(run(b.root, 'status', '--porcelain')).toBe('')
    expect((await a.sync.sync()).state).toBe('synced')
    expect(readFileSync(a.file('game/cards/G-1/shot.png'))).toEqual(png(3))
  })

  it('merges project.json, this machine\'s flag first, when both changed it', async () => {
    const a = machine(clone('a'))
    const b = machine(clone('b'))
    writeFileSync(a.file('project.json'), '{ "work": true, "jira": { "site": "https://a" } }\n')
    await a.sync.sync()
    writeFileSync(b.file('project.json'), '{ "work": false }\n')
    expect((await b.sync.sync()).state).toBe('synced')
    expect(JSON.parse(readFileSync(b.file('project.json'), 'utf8'))).toEqual({ work: false, jira: { site: 'https://a' } })
    expect((await a.sync.sync()).state).toBe('synced')
    expect(JSON.parse(readFileSync(a.file('project.json'), 'utf8')).work).toBe(false)
  })

  it("keeps the project's icon set on one machine when the other changed another setting", async () => {
    const a = machine(clone('a'))
    const b = machine(clone('b'))
    const icon = 'data:image/png;base64,iVBORw0KGgo='
    writeFileSync(a.file('project.json'), `${JSON.stringify({ icon })}\n`)
    await a.sync.sync()
    writeFileSync(b.file('project.json'), '{ "work": true }\n')
    expect((await b.sync.sync()).state).toBe('synced')
    expect(JSON.parse(readFileSync(b.file('project.json'), 'utf8'))).toEqual({ icon, work: true })
    expect((await a.sync.sync()).state).toBe('synced')
    expect(JSON.parse(readFileSync(a.file('project.json'), 'utf8'))).toEqual({ icon, work: true })
  })

  it('stops on a conflict it cannot settle and leaves the repo as it was', async () => {
    const a = machine(clone('a'))
    const b = machine(clone('b'))
    writeFileSync(a.file('README.md'), 'from a\n')
    await a.sync.sync()
    writeFileSync(b.file('README.md'), 'from b\n')
    const status = await b.sync.sync()
    expect(status.state).toBe('conflict')
    expect(status.message).toContain('README.md')
    expect(readFileSync(b.file('README.md'), 'utf8')).toBe('from b\n')
    expect(run(b.root, 'status', '--porcelain')).toBe('')
  })

  it('says so when there is no remote', async () => {
    const lone = path.join(dir, 'lone')
    execFileSync('git', ['init', '-q', lone])
    const status = await new BoardSync(lone, new AutoCommitter(lone, 10, () => {}), () => {}, 0).sync()
    expect(status.state).toBe('local')
  })

  it('reports an unreachable remote as offline', async () => {
    const a = machine(clone('a'))
    run(a.root, 'remote', 'set-url', 'origin', path.join(dir, 'gone.git'))
    expect((await a.sync.sync()).state).toBe('offline')
  })
})

describe('merge helpers', () => {
  it('newerCard compares the updated stamps, local on a tie', () => {
    const old = serializeCard(card('G-1', 'todo', '2026-10-01T00:00:00.000Z', 'old'))
    const fresh = serializeCard(card('G-1', 'todo', '2026-10-02T00:00:00.000Z', 'new'))
    expect(newerCard(old, fresh)).toBe(fresh)
    expect(newerCard(fresh, old)).toBe(fresh)
    expect(newerCard(old, old.replace('old', 'mine'))).toContain('mine')
    // A side that does not parse (a half-saved hand edit) loses; with both broken, no merge.
    const broken = '---\nid: G-1\ntitle: [unclosed\n---\n'
    expect(newerCard(broken, old)).toBe(old)
    expect(newerCard(fresh, broken)).toBe(fresh)
    expect(newerCard(broken, broken)).toBeUndefined()
  })

  it('mergeMaps and mergeBoards refuse broken JSON', () => {
    expect(mergeMaps('{', '{}')).toBeUndefined()
    expect(mergeBoards('{}', 'nope')).toBeUndefined()
  })
})
