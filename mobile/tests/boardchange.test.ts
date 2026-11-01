// Changing a board's board.json from the phone: written as the desktop's store writes it, named as
// the auto-commit names it, and made again on the newer file when it changed meanwhile, so two
// edits to different lists both survive.

import { describe, expect, it } from 'vitest'
import { RepoCache } from '../src/repo/cache'
import { applyBoardChange, changeBoard } from '../src/repo/boardchange'
import { refresh } from '../src/repo/reader'
import { github, MemoryStorage } from './fakes'

const at = { repo: 'me/board', board: 'cork' }

/** As the desktop writes it, with a key this build doesn't know and its own key order. */
const boardJson = (lists: object[]) =>
  `${JSON.stringify({ key: 'CORK', title: 'Cork', lists, flow: { doing: 'doing', done: 'done' }, mood: 'kept', created: '2026-01-01' }, null, 2)}\n`

const lists = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'Doing' },
  { id: 'done', title: 'Done' },
]

async function opened(files: Record<string, string> = { 'cork/board.json': boardJson(lists) }) {
  const gh = github(files)
  const cache = new RepoCache(new MemoryStorage())
  await refresh(gh.api, cache, 'me/board')
  return { gh, cache }
}

const written = (gh: ReturnType<typeof github>) => JSON.parse(gh.writes.at(-1)!.text)

describe('changing a board', () => {
  it('adds a list with a slug id, colours written down, every other key kept in its place', async () => {
    const { gh, cache } = await opened()
    await changeBoard(gh.api, cache, at, { kind: 'addList', title: 'Later, maybe' })
    const write = gh.writes.at(-1)!
    expect(write.message).toBe('Add list Later, maybe on cork')
    const meta = JSON.parse(write.text)
    expect(Object.keys(meta)).toEqual(['key', 'title', 'lists', 'flow', 'mood', 'created'])
    expect(meta.lists.at(-1)).toEqual({ id: 'later-maybe', title: 'Later, maybe', color: '#d9645b' })
    expect(meta.lists[0].color).toBe('#5b8def')
    expect(write.text.endsWith('}\n')).toBe(true)
  })

  it('keeps both of two edits to different lists made from two places', async () => {
    const { gh, cache } = await opened()
    // A desktop renamed a list and pushed, after the phone read the board.
    gh.put('cork/board.json', boardJson([{ id: 'todo', title: 'Next' }, lists[1], lists[2]]))
    await changeBoard(gh.api, cache, at, { kind: 'archiveList', list: 'doing' })
    const meta = written(gh)
    expect(meta.lists.map((l: { title: string }) => l.title)).toEqual(['Next', 'Doing', 'Done'])
    expect(meta.lists[1].archived).toBe(true)
    expect(gh.writes.at(-1)!.message).toBe('Archive list Doing on cork')
  })

  it('makes a new list’s id unique against the newer file', async () => {
    const { gh, cache } = await opened()
    gh.put('cork/board.json', boardJson([...lists, { id: 'later', title: 'Later' }]))
    await changeBoard(gh.api, cache, at, { kind: 'addList', title: 'Later' })
    expect(written(gh).lists.map((l: { id: string }) => l.id)).toEqual(['todo', 'doing', 'done', 'later', 'later-2'])
  })

  it('renames without changing the id, sorts, recolours, restores and sets the flow', async () => {
    const { gh, cache } = await opened()
    await changeBoard(gh.api, cache, at, { kind: 'renameList', list: 'todo', title: 'Next up' })
    expect(written(gh).lists[0]).toEqual({ id: 'todo', title: 'Next up' })
    await changeBoard(gh.api, cache, at, { kind: 'sortList', list: 'todo', sort: 'newest' })
    expect(gh.writes.at(-1)!.message).toBe('Sort Next up by Newest first on cork')
    await changeBoard(gh.api, cache, at, { kind: 'colorList', list: 'done', color: '#a77bdb' })
    expect(gh.writes.at(-1)!.message).toBe('Recolour list Done on cork')
    await changeBoard(gh.api, cache, at, { kind: 'archiveList', list: 'doing' })
    await changeBoard(gh.api, cache, at, { kind: 'restoreList', list: 'doing' })
    expect(gh.writes.at(-1)!.message).toBe('Restore list Doing on cork')
    expect(written(gh).lists[1].archived).toBeUndefined()
    await changeBoard(gh.api, cache, at, { kind: 'flow', doing: null })
    expect(written(gh).flow).toEqual({ done: 'done' })
    expect(gh.writes.at(-1)!.message).toBe('Tackling leaves cards where they are on cork')
    await changeBoard(gh.api, cache, at, { kind: 'flow', done: null })
    expect(written(gh).flow).toBeUndefined()
    await changeBoard(gh.api, cache, at, { kind: 'title', title: 'Corkboard' })
    expect(gh.writes.at(-1)!.message).toBe('Rename board cork: Corkboard')
  })

  it('moves a list past its visible neighbour, archived ones staying put', () => {
    const meta = { key: 'C', title: 'C', lists: [lists[0], { id: 'old', title: 'Old', archived: true }, lists[1], lists[2]] }
    const moved = applyBoardChange(meta, { kind: 'moveList', list: 'todo', by: 1 })
    expect(moved.lists.map(l => l.id)).toEqual(['doing', 'old', 'todo', 'done'])
    expect(applyBoardChange(meta, { kind: 'moveList', list: 'todo', by: -1 })).toBe(meta)
  })

  it('writes nothing for no change, and refuses a list that is gone', async () => {
    const { gh, cache } = await opened()
    await changeBoard(gh.api, cache, at, { kind: 'renameList', list: 'todo', title: 'To do' })
    expect(gh.writes).toHaveLength(0)
    gh.put('cork/board.json', boardJson([lists[0], lists[2]]))
    await expect(changeBoard(gh.api, cache, at, { kind: 'archiveList', list: 'doing' })).rejects.toThrow('no longer on this board')
  })
})
