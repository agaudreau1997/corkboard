import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    const code = os.tmpdir()
    await store.updateMeta(parent, { codeRepo: code })
    const child = await store.createBoard(parent, 'Ideas')
    const other = await store.createBoard('', 'Robot shooter', 'RS')

    expect(parent).toBe('robot-shooter')
    expect(child).toBe('robot-shooter/ideas')
    expect(other).toBe('robot-shooter-2')
    expect(store.board(other).meta.key).toBe('RS2')
    expect(store.board(child).codeRepo).toBe(code)

    const fresh = new BoardStore(root)
    await fresh.init()
    const tree = fresh.tree()
    expect(tree.map(n => n.path)).toEqual(['robot-shooter', 'robot-shooter-2'])
    expect(tree[0].children.map(n => n.path)).toEqual(['robot-shooter/ideas'])
    expect(fresh.board('robot-shooter/ideas').codeRepo).toBe(code)
  })

  it('resolves code repos: this machine first, then board.json, relative to the repo', async () => {
    const store = new BoardStore(root)
    await store.init()
    const parent = await store.createBoard('', 'Game', 'G')
    const child = await store.createBoard(parent, 'Ideas', 'I')
    const sibling = mkdtempSync(path.join(path.dirname(root), 'game-code-'))
    const relative = path.relative(root, sibling)
    await store.updateMeta(parent, { codeRepo: relative })
    expect(store.board(child).codeRepo).toBe(sibling)
    rmSync(sibling, { recursive: true })
    store.setLocalRepos({ [parent]: '/elsewhere/game' })
    expect(store.board(child).codeRepo).toBe('/elsewhere/game')
    expect(store.board(child).codeRepoLocal).toBe(true)
    store.setLocalRepos({})
    expect(store.board(parent).codeRepoLocal).toBeFalsy()
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

  it('moves a card and a whole list to another board, ids kept', async () => {
    const store = new BoardStore(root)
    await store.init()
    const a = await store.createBoard('', 'Alpha', 'A')
    const b = await store.createBoard('', 'Beta', 'B')
    const one = await store.createCard(a, { title: 'One', list: 'todo' })
    await store.createCard(a, { title: 'Two', list: 'doing' })
    await store.createCard(a, { title: 'Three', list: 'doing' })

    const moved = await store.moveCard(a, one.id, b, 'done')
    expect(moved.id).toBe('A-1')
    expect(readFileSync(store.cardFile(b, 'A-1'), 'utf8')).toContain('list: done')
    expect(() => readFileSync(store.cardFile(a, 'A-1'))).toThrow()
    // B's own numbering ignores the guest: its next card is B-1.
    expect((await store.createCard(b, { title: 'Native', list: 'todo' })).id).toBe('B-1')

    const listId = await store.moveList(a, 'doing', b)
    expect(listId).toBe('doing-2')
    expect(store.board(b).meta.lists.at(-1)).toEqual({ id: 'doing-2', title: 'Doing' })
    expect(store.board(a).meta.lists.map(l => l.id)).toEqual(['todo', 'done'])
    expect(store.board(b).cards.filter(c => c.list === 'doing-2').map(c => c.id)).toEqual(['A-2', 'A-3'])
    expect(store.board(a).cards).toEqual([])
  })

  it('deletes a board with cards and children when forced', async () => {
    const store = new BoardStore(root)
    await store.init()
    const p = await store.createBoard('', 'Old game', 'OG')
    const child = await store.createBoard(p, 'Old ideas', 'OI')
    await store.createCard(p, { title: 'x', list: 'todo' })
    await store.createCard(child, { title: 'y', list: 'todo' })
    await expect(store.deleteBoard(p)).rejects.toThrow()
    await store.deleteBoard(p, true)
    expect(store.tree()).toEqual([])
    expect(() => readFileSync(path.join(root, p, 'board.json'))).toThrow()
  })

  it('hands a card to another repo and takes it back out (ids kept)', async () => {
    const a = new BoardStore(root)
    await a.init()
    const otherRoot = mkdtempSync(path.join(os.tmpdir(), 'corkboard-other-'))
    const b = new BoardStore(otherRoot)
    await b.init()
    const pa = await a.createBoard('', 'Alpha', 'A')
    const pb = await b.createBoard('', 'Beta', 'B')
    const card = await a.createCard(pa, { title: 'Travels', list: 'todo' })
    await b.adoptCard(pb, { ...card, list: 'done' })
    await a.dropCard(pa, card.id)
    expect(parseCard(readFileSync(b.cardFile(pb, 'A-1'), 'utf8'))).toMatchObject({ id: 'A-1', list: 'done' })
    expect(a.board(pa).cards).toEqual([])
    rmSync(otherRoot, { recursive: true, force: true })
  })

  it('falls back to the project code folder, and prefers a board.json repo that exists here', async () => {
    const store = new BoardStore(root, {}, '/project/code')
    await store.init()
    const p = await store.createBoard('', 'Game', 'G')
    expect(store.board(p).codeRepo).toBe('/project/code')
    await store.updateMeta(p, { codeRepo: '/does/not/exist/here' })
    expect(store.board(p).codeRepo).toBe('/project/code')
    await store.updateMeta(p, { codeRepo: root })
    expect(store.board(p).codeRepo).toBe(root)
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

    // ...saves one half-way (front matter that does not parse): the card stays as it was...
    writeFileSync(store.cardFile(p, 'G-7'), '---\nid: G-7\ntitle: [unclosed\nlist: done\n---\n')
    await sleep(300)
    expect(store.board(p).cards.find(c => c.id === 'G-7')?.list).toBe('todo')
    writeFileSync(store.cardFile(p, 'G-7'), '---\nid: G-7\ntitle: Written by hand\nlist: done\npos: 5\n---\n')
    await until(() => deltas.find(d => d.cards.some(c => c.id === 'G-7' && c.list === 'done')))

    // ...and removes one.
    rmSync(store.cardFile(p, 'G-7'))
    await until(() => deltas.find(d => d.removed.includes('G-7')))
    expect(store.board(p).cards.map(c => c.id)).toEqual([card.id])
    store.close()
  })

  it('reads, writes and watches the project theme at the root', async () => {
    writeFileSync(path.join(root, 'theme.json'), '{\n  "colors": { "accent": "#D9A46C" },\n  "fonts": "kept"\n}\n')
    const store = new BoardStore(root)
    await store.init()
    expect(store.theme).toEqual({ colors: { accent: '#d9a46c' } })
    let treeChanges = 0
    store.watch({ onDelta: () => {}, onTreeChanged: () => treeChanges++ })
    await sleep(100)

    // Saved from the settings: the file keeps what this app does not know, and is not echoed back.
    await store.saveTheme({ name: 'Cork', colors: { background: '#1f1610', accent: '#d9a46c' } })
    expect(JSON.parse(readFileSync(path.join(root, 'theme.json'), 'utf8'))).toEqual({
      name: 'Cork',
      colors: { background: '#1f1610', accent: '#d9a46c' },
      fonts: 'kept',
    })
    expect(treeChanges).toBe(1)
    await sleep(300)
    expect(treeChanges).toBe(1)

    // Edited by hand (or pulled from the other machine): the theme follows the file.
    writeFileSync(path.join(root, 'theme.json'), '{ "colors": { "accent": "#5ec4d6" } }\n')
    await until(() => store.theme?.colors.accent === '#5ec4d6')
    expect(treeChanges).toBe(2)
    // Half saved: the colours on screen stay until the file reads again.
    writeFileSync(path.join(root, 'theme.json'), '{ "colors": { "acc')
    await sleep(300)
    expect(store.theme?.colors.accent).toBe('#5ec4d6')
    rmSync(path.join(root, 'theme.json'))
    await until(() => store.theme === undefined)

    // A file with no colour is no theme; an empty theme is no file at all.
    writeFileSync(path.join(root, 'theme.json'), '{ "name": "Nothing yet" }\n')
    await until(() => treeChanges === 4)
    expect(store.theme).toBeUndefined()
    await store.saveTheme({ colors: { text: '#ffffff' } })
    await store.saveTheme({ colors: {} })
    expect(existsSync(path.join(root, 'theme.json'))).toBe(false)
    expect(store.theme).toBeUndefined()
    await store.saveTheme(null)
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

describe('the watch and git', () => {
  it('keeps seeing card files through commits, branch switches and a rebase', async () => {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
    run('init', '-q', '-b', 'main')
    run('config', 'user.email', 't@example.com')
    run('config', 'user.name', 'Test')
    const store = new BoardStore(root)
    await store.init()
    const p = await store.createBoard('', 'Game', 'G')
    const card = await store.createCard(p, { title: 'Watched', list: 'todo' })
    const second = await store.createCard(p, { title: 'Second', list: 'todo' })
    run('add', '-A')
    run('commit', '-q', '-m', 'seed')
    const deltas: BoardDelta[] = []
    store.watch({ onDelta: d => deltas.push(d), onTreeChanged: () => {} })
    await sleep(100)

    // Another branch moves one card; main renames the other; rebase main onto the other branch.
    run('checkout', '-q', '-b', 'other')
    writeFileSync(store.cardFile(p, card.id), serializeCard({ ...card, list: 'done' }))
    run('commit', '-qam', 'move')
    run('checkout', '-q', 'main')
    writeFileSync(store.cardFile(p, second.id), serializeCard({ ...second, title: 'Renamed' }))
    run('commit', '-qam', 'rename')
    run('rebase', '-q', 'other')
    await until(() => store.board(p).cards.find(c => c.id === card.id && c.list === 'done'))
    await until(() => store.board(p).cards.find(c => c.id === second.id && c.title === 'Renamed'))

    // After all that .git churn, a plain edit still arrives.
    writeFileSync(store.cardFile(p, card.id), serializeCard({ ...card, title: 'Still watched', list: 'done' }))
    await until(() => deltas.find(d => d.cards.some(c => c.title === 'Still watched')))
    store.close()
  })

  it('reads a cards folder that appears with its first card', async () => {
    const store = new BoardStore(root)
    await store.init()
    const p = await store.createBoard('', 'Fresh', 'F')
    rmSync(path.join(root, p, 'cards'), { recursive: true })
    store.watch({ onDelta: () => {}, onTreeChanged: () => {} })
    await sleep(100)
    execFileSync('mkdir', [path.join(root, p, 'cards')])
    writeFileSync(path.join(root, p, 'cards', 'F-1.md'), '---\nid: F-1\ntitle: First\nlist: todo\npos: 1\n---\n')
    await until(() => store.board(p).cards.find(c => c.id === 'F-1'))
    writeFileSync(path.join(root, p, 'cards', 'F-2.md'), '---\nid: F-2\ntitle: Second\nlist: todo\npos: 2\n---\n')
    await until(() => store.board(p).cards.find(c => c.id === 'F-2'))
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
    // A card that does not parse (saved half-way by hand) is still committed, never stuck.
    writeFileSync(store.cardFile(p, 'G-1'), '---\nid: G-1\ntitle: [unclosed\n---\n')
    expect(await committer.flush()).toBe('Edit G-1')
    await store.saveTheme({ colors: { accent: '#d9a46c' } })
    expect(await committer.flush()).toBe("Add the project's theme")
    await store.saveTheme({ colors: { accent: '#5ec4d6' } })
    expect(await committer.flush()).toBe("Edit the project's theme")
    await store.saveTheme(null)
    expect(await committer.flush()).toBe("Remove the project's theme")
    const log = await git(root, ['log', '--format=%s'])
    expect(log.trim().split('\n').slice(-3)).toEqual(['Archive G-1', 'Move G-1: todo → done', 'Board: 2 changes'])
    expect(committed.length).toBe(7)
  })

  it('waits for a commit in flight, then commits what came after it', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
    const store = new BoardStore(root)
    await store.init()
    const p = await store.createBoard('', 'Game', 'G')
    await store.createCard(p, { title: 'First', list: 'todo' })
    const committer = new AutoCommitter(root, 10_000, () => {})
    const first = committer.flush()
    await store.createCard(p, { title: 'Second', list: 'todo' })
    await committer.flush()
    // Whoever asked (the sync, before it rebases) finds nothing left to commit.
    expect(await git(root, ['status', '--porcelain'])).toBe('')
    await first
    const log = await git(root, ['log', '--format=%B'])
    expect(log).toContain('Add G-1: First')
    expect(log).toContain('Add G-2: Second')
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
