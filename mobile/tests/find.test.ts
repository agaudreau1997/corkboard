// Finding cards on a board from the phone: the desktop's match, results in the board's order with
// archived ones last, and the archive the last changed first.

import { describe, expect, it } from 'vitest'
import { parseCard } from '@shared/cardfile'
import type { BoardMeta } from '@shared/types'
import { archivedCards, findCards, whereCard } from '../src/repo/find'
import { card } from './fakes'

const meta: BoardMeta = {
  key: 'CORK',
  title: 'Cork',
  lists: [
    { id: 'todo', title: 'To do' },
    { id: 'old', title: 'Old', archived: true },
    { id: 'done', title: 'Done', sort: 'manual' },
  ],
}

const cards = [
  card({ id: 'CORK-1', title: 'Login screen', list: 'done', pos: 1024 }),
  card({ id: 'CORK-2', title: 'Fix the LOGIN', list: 'todo', pos: 2048 }),
  card({ id: 'CORK-3', title: 'Other', list: 'todo', pos: 1024, body: 'about the login flow' }),
  card({ id: 'CORK-4', title: 'Login, archived', list: 'todo', pos: 512, archived: true, updated: '2026-10-01T00:00:00.000Z' }),
  card({ id: 'CORK-5', title: 'Login in an archived list', list: 'old', pos: 512 }),
  card({ id: 'CORK-6', title: 'Login idea', list: null, pos: 512 }),
  card({ id: 'CORK-7', title: 'Archived later', list: 'done', pos: 512, archived: true, updated: '2026-10-20T00:00:00.000Z' }),
  card({ id: 'CORK-8', title: '---', list: 'todo', pos: 1500 }),
].map(text => parseCard(text))

const board = { meta, cards }

describe('finding cards', () => {
  it('finds by id, title or description, ignoring case, in the board’s order, archived last', () => {
    expect(findCards(board, 'login').map(c => c.id)).toEqual(['CORK-6', 'CORK-3', 'CORK-2', 'CORK-1', 'CORK-4'])
    expect(findCards(board, 'cork-7').map(c => c.id)).toEqual(['CORK-7'])
    expect(findCards(board, 'nothing like it')).toEqual([])
  })

  it('lists the archive, the last changed first, and says where each card is', () => {
    expect(archivedCards(board).map(c => c.id)).toEqual(['CORK-7', 'CORK-4'])
    const byId = (id: string) => cards.find(c => c.id === id)!
    expect(whereCard(board, byId('CORK-4'))).toBe('Archived · To do')
    expect(whereCard(board, byId('CORK-6'))).toBe('Ideas')
    expect(whereCard(board, byId('CORK-1'))).toBe('Done')
  })
})
