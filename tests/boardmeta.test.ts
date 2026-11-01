// A board's board.json as the store and the companion change it: keys kept in their order, new
// list ids slugs unique among the board's lists, and a commit line that says what changed.

import { describe, expect, it } from 'vitest'
import { describeBoardChange, metaText, newListId, parseMetaText, patchMeta, uniqueListId } from '@shared/boardmeta'
import type { BoardMeta } from '@shared/types'

const meta: BoardMeta = {
  key: 'CORK',
  title: 'Cork',
  lists: [
    { id: 'todo', title: 'To do' },
    { id: 'doing', title: 'Doing' },
    { id: 'done', title: 'Done' },
  ],
  flow: { doing: 'doing', done: 'done' },
}

describe('board.json', () => {
  it('makes a new list’s id from its title, unique among the lists', () => {
    expect(newListId('Later, maybe', meta.lists)).toBe('later-maybe')
    expect(newListId('To do', meta.lists)).toBe('to-do')
    expect(newListId('Done!', meta.lists)).toBe('done-2')
    expect(uniqueListId('done', [...meta.lists, { id: 'done-2' }])).toBe('done-3')
    expect(newListId('???', [])).toBe('list')
  })

  it('patches in place: the key and key order kept, unknown keys kept, empty values dropped', () => {
    const text = '{\n  "title": "Cork",\n  "key": "CORK",\n  "mood": "kept",\n  "lists": [],\n  "promptNotes": "x"\n}\n'
    const patched = patchMeta(parseMetaText(text)!, { title: 'Corkboard', key: 'NOPE', promptNotes: '' })
    expect(metaText(patched)).toBe('{\n  "title": "Corkboard",\n  "key": "CORK",\n  "mood": "kept",\n  "lists": []\n}\n')
    expect(parseMetaText('[]')).toBeUndefined()
    expect(parseMetaText('{ "key": "A" }')?.lists).toEqual([])
  })

  it('says what changed, for the commit', () => {
    const say = (now: Partial<BoardMeta>) => describeBoardChange('cork', meta, { ...meta, ...now })
    const lists = (...edit: ((l: BoardMeta['lists']) => BoardMeta['lists'])[]) => edit.reduce((l, f) => f(l), meta.lists)
    expect(say({ title: 'Corkboard' })).toEqual(['Rename board cork: Corkboard'])
    expect(say({ lists: [...meta.lists, { id: 'later', title: 'Later' }] })).toEqual(['Add list Later on cork'])
    expect(say({ lists: lists(l => l.map(x => (x.id === 'todo' ? { ...x, title: 'Next' } : x))) })).toEqual(['Rename list To do → Next on cork'])
    expect(say({ lists: lists(l => l.map(x => (x.id === 'doing' ? { ...x, archived: true } : x))) })).toEqual(['Archive list Doing on cork'])
    expect(describeBoardChange('cork', { ...meta, lists: lists(l => l.map(x => ({ ...x, archived: true }))) }, meta)).toHaveLength(3)
    expect(say({ lists: lists(l => l.map(x => (x.id === 'todo' ? { ...x, sort: 'newest' } : x))) })).toEqual(['Sort To do by Newest first on cork'])
    expect(say({ lists: lists(l => l.map(x => (x.id === 'todo' ? { ...x, color: '#ff0000' } : x))) })).toEqual(['Recolour list To do on cork'])
    expect(say({ lists: [meta.lists[1], meta.lists[0], meta.lists[2]] })).toContain('Reorder the lists on cork')
    expect(say({ flow: { doing: 'todo', done: 'done' } })).toEqual(['Tackling moves cards to To do on cork'])
    expect(say({ flow: { doing: 'doing' } })).toEqual(['Finished cards stay where they are on cork'])
    expect(say({ promptNotes: 'x' })).toEqual(['Edit board cork'])
    expect(describeBoardChange('cork', undefined, meta)).toEqual(['Edit board cork'])
  })

  it('doesn’t call colours written down for the lists a recolour', () => {
    const frozen = meta.lists.map((l, i) => ({ ...l, color: ['#5b8def', '#e0a93b', '#4cb782'][i] }))
    expect(describeBoardChange('cork', meta, { ...meta, lists: [...frozen, { id: 'later', title: 'Later', color: '#d9645b' }] })).toEqual([
      'Add list Later on cork',
    ])
  })
})
