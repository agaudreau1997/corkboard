// Reading a board repo through GitHub: boards found in the tree as the desktop finds them in its
// folders, files read in GraphQL batches by sha, kept in the cache by sha, and a refresh that
// reads only what changed.

import { describe, expect, it } from 'vitest'
import { serializeCard } from '@shared/cardfile'
import { boardColumns } from '@shared/selection'
import type { Card } from '@shared/types'
import { BATCH, blobsQuery } from '../src/repo/blobs'
import { RepoCache } from '../src/repo/cache'
import { boardTree, findBoards, type TreeEntry } from '../src/repo/layout'
import { boardMetas, openBoard, refresh } from '../src/repo/reader'

/** A Storage in memory, as localStorage is on the phone. */
class MemoryStorage implements Storage {
  private items = new Map<string, string>()
  get length() {
    return this.items.size
  }
  key(i: number) {
    return [...this.items.keys()][i] ?? null
  }
  getItem(k: string) {
    return this.items.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.items.set(k, v)
  }
  removeItem(k: string) {
    this.items.delete(k)
  }
  clear() {
    this.items.clear()
  }
}

let shas = 0
const sha = () => (++shas).toString(16).padStart(40, '0')

function card(fields: Partial<Card> & { id: string; title: string; list: string | null; pos: number }): string {
  return serializeCard({ labels: [], links: [], after: [], sessions: [], body: '', extra: {}, ...fields })
}

/** A repo on a stand-in GitHub: files by path; the tree and the GraphQL reads are made from them. */
function github(files: Record<string, string>) {
  const blobs = new Map<string, string>()
  const tree: TreeEntry[] = []
  const put = (path: string, text: string) => {
    const s = sha()
    blobs.set(s, text)
    const at = tree.findIndex(e => e.path === path)
    if (at >= 0) tree[at] = { path, type: 'blob', sha: s }
    else tree.push({ path, type: 'blob', sha: s })
  }
  for (const [path, text] of Object.entries(files)) put(path, text)
  const asked: string[][] = []
  const api = async (path: string, init?: RequestInit) => {
    if (path === '/repos/me/board') return Response.json({ default_branch: 'main' })
    if (path === '/repos/me/board/git/trees/main?recursive=1') return Response.json({ sha: sha(), truncated: false, tree })
    if (path === '/graphql') {
      const query = JSON.parse(String(init?.body)).query as string
      const wanted = [...query.matchAll(/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g)]
      asked.push(wanted.map(m => m[2]))
      const repository = Object.fromEntries(wanted.map(([, alias, s]) => [alias, { text: blobs.get(s), isBinary: false }]))
      return Response.json({ data: { repository } })
    }
    return new Response('{}', { status: 404 })
  }
  return { api, put, asked }
}

const meta = (key: string, title: string, lists: object[]) => JSON.stringify({ key, title, lists })

describe('finding boards in the tree', () => {
  it('finds boards and child boards, never the root or cards/ and dot folders', () => {
    const entries = ['board.json', 'cork/board.json', 'cork/cards/CORK-1.md', 'cork/cards/CORK-2.md', 'cork/art/board.json', 'cork/cards/x/board.json', '.github/board.json', 'cork/notes.md']
    const boards = findBoards(entries.map(path => ({ path, type: 'blob', sha: sha() })))
    expect(boards.map(b => b.path)).toEqual(['cork', 'cork/art'])
    expect(boards[0].cards.map(c => c.id)).toEqual(['CORK-1', 'CORK-2'])
  })

  it('nests child boards under their parents, by title', () => {
    const tree = boardTree([
      { path: 'game', meta: { key: 'G', title: 'Game' } },
      { path: 'game/levels/ui', meta: { key: 'UI', title: 'UI' } },
      { path: 'game/art', meta: { key: 'ART', title: 'Art' } },
      { path: 'cork', meta: { key: 'CORK', title: 'Cork' } },
    ])
    expect(tree.map(n => n.title)).toEqual(['Cork', 'Game'])
    expect(tree[1].children.map(n => n.title)).toEqual(['Art', 'UI'])
  })
})

describe('reading files by sha', () => {
  it('splits a long read into batches', () => {
    expect(blobsQuery([sha()])).toContain('b0: object(oid:')
    expect(() => blobsQuery(['not a sha'])).toThrow()
    expect(BATCH).toBe(100)
  })
})

describe('reading a board repo', () => {
  const files = () => ({
    'cork/board.json': meta('CORK', 'Cork', [{ id: 'todo', title: 'To do' }, { id: 'old', title: 'Old', archived: true }, { id: 'done', title: 'Done' }]),
    'cork/cards/CORK-1.md': card({ id: 'CORK-1', title: 'First', list: 'todo', pos: 2048 }),
    'cork/cards/CORK-2.md': card({ id: 'CORK-2', title: 'Second', list: 'todo', pos: 1024 }),
    'cork/cards/CORK-3.md': card({ id: 'CORK-3', title: 'Gone', list: 'todo', pos: 512, archived: true }),
    'cork/cards/CORK-4.md': card({ id: 'CORK-4', title: '---', list: 'todo', pos: 1536 }),
  })

  it('reads the boards with the tree, and a board’s cards when it opens', async () => {
    const gh = github(files())
    const cache = new RepoCache(new MemoryStorage())
    const snapshot = await refresh(gh.api, cache, 'me/board')
    expect(gh.asked).toHaveLength(1)
    expect(boardMetas(cache, snapshot).map(b => b.meta.title)).toEqual(['Cork'])
    const board = await openBoard(gh.api, cache, snapshot, 'cork')
    expect(gh.asked).toHaveLength(2)
    expect(gh.asked[1]).toHaveLength(4)
    const columns = boardColumns(board!, () => true)
    expect(columns.todo).toEqual(['CORK-2', 'CORK-4', 'CORK-1'])
  })

  it('reads only the files that changed on a refresh', async () => {
    const gh = github(files())
    const cache = new RepoCache(new MemoryStorage())
    await openBoard(gh.api, cache, await refresh(gh.api, cache, 'me/board'), 'cork')
    gh.put('cork/cards/CORK-1.md', card({ id: 'CORK-1', title: 'First, moved', list: 'done', pos: 1024 }))
    gh.asked.length = 0
    const board = await openBoard(gh.api, cache, await refresh(gh.api, cache, 'me/board'), 'cork')
    expect(gh.asked.flat()).toHaveLength(1)
    expect(board!.cards.find(c => c.id === 'CORK-1')!.list).toBe('done')
  })

  it('opens from the cache alone, offline, and says how many cards it lacks', async () => {
    const gh = github(files())
    const storage = new MemoryStorage()
    const snapshot = await refresh(gh.api, new RepoCache(storage), 'me/board')
    const later = new RepoCache(storage)
    expect(later.snapshot('me/board')?.tree).toBe(snapshot.tree)
    const board = await openBoard(undefined, later, later.snapshot('me/board')!, 'cork')
    expect(board?.meta.title).toBe('Cork')
    expect(board?.missing).toBe(4)
  })

  it('drops files no snapshot names any more', async () => {
    const gh = github(files())
    const storage = new MemoryStorage()
    const cache = new RepoCache(storage)
    await openBoard(gh.api, cache, await refresh(gh.api, cache, 'me/board'), 'cork')
    const before = storage.length
    gh.put('cork/cards/CORK-1.md', card({ id: 'CORK-1', title: 'Edited', list: 'todo', pos: 2048 }))
    await refresh(gh.api, cache, 'me/board')
    expect(storage.length).toBe(before - 1)
  })
})
