// Changing a card from the phone: the change stamped and written as the desktop writes it, one
// commit named as the auto-commit names it, and a card changed elsewhere meanwhile handled without
// losing anyone's edit.

import { describe, expect, it } from 'vitest'
import { parseCard } from '@shared/cardfile'
import { RepoCache } from '../src/repo/cache'
import { changeCard, Conflict } from '../src/repo/editor'
import { openBoard, refresh } from '../src/repo/reader'
import { card, github, MemoryStorage, meta } from './fakes'

const NOW = '2026-11-01T22:00:00.000Z'
const at = { repo: 'me/board', board: 'cork' }

const files = () => ({
  'cork/board.json': meta('CORK', 'Cork', [
    { id: 'todo', title: 'To do' },
    { id: 'done', title: 'Done' },
  ]),
  'cork/cards/CORK-1.md': card({
    id: 'CORK-1',
    title: 'Jot',
    list: 'todo',
    pos: 1024,
    body: 'The first line.',
    sessions: [{ kind: 'local', started: '2026-10-01T00:00:00.000Z' }],
    extra: { mood: 'kept' },
  }),
  'cork/cards/CORK-2.md': card({ id: 'CORK-2', title: 'Already done', list: 'done', pos: 4096 }),
})

/** The repo read as the phone reads it, and CORK-1 as it was read. */
async function opened(gh: ReturnType<typeof github>) {
  const cache = new RepoCache(new MemoryStorage())
  const board = (await openBoard(gh.api, cache, await refresh(gh.api, cache, 'me/board'), 'cork'))!
  const read = board.cards.find(c => c.id === 'CORK-1')!
  return { cache, read, sha: board.shas['CORK-1'] }
}

const options = { now: () => NOW }

describe('changing a card', () => {
  it('moves it to the end of another list, in a one-line diff, stamped, keeping what it doesn’t know', async () => {
    const gh = github(files())
    const { cache, read, sha } = await opened(gh)
    const before = gh.writes.length
    await changeCard(gh.api, cache, at, read, sha, { list: 'done' }, options)
    const write = gh.writes[before]
    expect(write.message).toBe('Move CORK-1: todo → done')
    const now = parseCard(write.text)
    expect(now).toMatchObject({ list: 'done', pos: 5120, updated: NOW, extra: { mood: 'kept' } })
    expect(now.sessions).toHaveLength(1)
  })

  it('names an archive, a rename and an edit as the auto-commit does', async () => {
    for (const [change, message] of [
      [{ archived: true }, 'Archive CORK-1'],
      [{ title: 'Jotted' }, 'Rename CORK-1: Jotted'],
      [{ body: 'A new line.' }, 'Edit CORK-1'],
      [{ complete: true }, 'Edit CORK-1'],
    ] as const) {
      const gh = github(files())
      const { cache, read, sha } = await opened(gh)
      await changeCard(gh.api, cache, at, read, sha, change, options)
      expect(gh.writes.at(-1)!.message).toBe(message)
    }
  })

  it('moves a card changed elsewhere meanwhile on top of that change', async () => {
    const gh = github(files())
    const { cache, read, sha } = await opened(gh)
    gh.put('cork/cards/CORK-1.md', card({ id: 'CORK-1', title: 'Jot', list: 'todo', pos: 1024, body: 'Edited on the desktop.' }))
    await changeCard(gh.api, cache, at, read, sha, { list: 'done' }, options)
    const now = parseCard(gh.writes.at(-1)!.text)
    expect(now).toMatchObject({ list: 'done', body: 'Edited on the desktop.' })
  })

  it('asks before overwriting a description edited elsewhere, and overwrites when told to', async () => {
    const gh = github(files())
    const { cache, read, sha } = await opened(gh)
    gh.put('cork/cards/CORK-1.md', card({ id: 'CORK-1', title: 'Jot', list: 'todo', pos: 1024, body: 'Theirs.' }))
    const error = await changeCard(gh.api, cache, at, read, sha, { body: 'Mine.' }, options).catch(e => e)
    expect(error).toBeInstanceOf(Conflict)
    expect(error.theirs.body).toBe('Theirs.')
    expect(gh.writes).toHaveLength(0)
    await changeCard(gh.api, cache, at, read, sha, { body: 'Mine.' }, { ...options, overwrite: true })
    expect(parseCard(gh.writes.at(-1)!.text).body).toBe('Mine.')
  })

  it('applies a title edit on top when only the list changed elsewhere', async () => {
    const gh = github(files())
    const { cache, read, sha } = await opened(gh)
    gh.put('cork/cards/CORK-1.md', card({ id: 'CORK-1', title: 'Jot', list: 'done', pos: 8000, body: 'The first line.' }))
    await changeCard(gh.api, cache, at, read, sha, { title: 'Jotted' }, options)
    expect(parseCard(gh.writes.at(-1)!.text)).toMatchObject({ title: 'Jotted', list: 'done' })
  })

  it('restores an archived card to the end of its list, or as an idea when its list is gone or archived', async () => {
    for (const [lists, list, pos] of [
      [[{ id: 'todo', title: 'To do' }, { id: 'done', title: 'Done' }], 'todo', 5120],
      [[{ id: 'todo', title: 'To do', archived: true }, { id: 'done', title: 'Done' }], null, 1024],
      [[{ id: 'done', title: 'Done' }], null, 1024],
    ] as const) {
      const gh = github({
        ...files(),
        'cork/board.json': meta('CORK', 'Cork', [...lists]),
        'cork/cards/CORK-3.md': card({ id: 'CORK-3', title: 'Back', list: 'todo', pos: 100, archived: true }),
        'cork/cards/CORK-4.md': card({ id: 'CORK-4', title: 'Last', list: 'todo', pos: 4096 }),
      })
      const cache = new RepoCache(new MemoryStorage())
      const board = (await openBoard(gh.api, cache, await refresh(gh.api, cache, 'me/board'), 'cork'))!
      const read = board.cards.find(c => c.id === 'CORK-3')!
      await changeCard(gh.api, cache, at, read, board.shas['CORK-3'], { restore: true }, options)
      const write = gh.writes.at(-1)!
      expect(write.message).toBe('Restore CORK-3')
      const now = parseCard(write.text)
      expect(now.archived).toBeUndefined()
      expect([now.list, now.pos]).toEqual([list, pos])
    }
  })

  it('decides where a restored card goes against the board as it is when written', async () => {
    const gh = github({ ...files(), 'cork/cards/CORK-3.md': card({ id: 'CORK-3', title: 'Back', list: 'todo', pos: 100, archived: true }) })
    const cache = new RepoCache(new MemoryStorage())
    const board = (await openBoard(gh.api, cache, await refresh(gh.api, cache, 'me/board'), 'cork'))!
    // A desktop archived the list and touched the card meanwhile.
    gh.put('cork/board.json', meta('CORK', 'Cork', [{ id: 'todo', title: 'To do', archived: true }, { id: 'done', title: 'Done' }]))
    gh.put('cork/cards/CORK-3.md', card({ id: 'CORK-3', title: 'Back', list: 'todo', pos: 100, archived: true, labels: ['x'] }))
    await changeCard(gh.api, cache, at, board.cards.find(c => c.id === 'CORK-3')!, board.shas['CORK-3'], { restore: true }, options)
    expect(parseCard(gh.writes.at(-1)!.text)).toMatchObject({ list: null, labels: ['x'] })
  })
})
