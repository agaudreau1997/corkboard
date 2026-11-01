// A card's linked cards: the open board's at once, another board's from the cache when the phone
// has read it, and by id alone otherwise, without a read of their own.

import { describe, expect, it } from 'vitest'
import { RepoCache } from '../src/repo/cache'
import { linkedCards } from '../src/repo/linked'
import { openBoard, refresh } from '../src/repo/reader'
import { card, github, MemoryStorage, meta } from './fakes'

describe('linked cards', () => {
  it('finds a card on the open board, on another board read before, on one never read, or nowhere', async () => {
    const gh = github({
      'cork/board.json': meta('CORK', 'Cork', [{ id: 'todo', title: 'To do' }]),
      'cork/cards/CORK-1.md': card({ id: 'CORK-1', title: 'Here', list: 'todo', pos: 1, links: ['CORK-2', 'ART-1', 'GAME-1', 'GONE-9'] }),
      'cork/cards/CORK-2.md': card({ id: 'CORK-2', title: 'Beside', list: 'todo', pos: 2 }),
      'art/board.json': meta('ART', 'Art', []),
      'art/cards/ART-1.md': card({ id: 'ART-1', title: 'Drawn', list: null, pos: 1 }),
      'game/board.json': meta('GAME', 'Game', []),
      'game/cards/GAME-1.md': card({ id: 'GAME-1', title: 'Unread', list: null, pos: 1 }),
    })
    const cache = new RepoCache(new MemoryStorage())
    const snapshot = await refresh(gh.api, cache, 'me/board')
    await openBoard(gh.api, cache, snapshot, 'art')
    const open = (await openBoard(gh.api, cache, snapshot, 'cork'))!
    const reads = gh.asked.length
    const linked = linkedCards(cache, snapshot, open, open.cards[0].links)
    expect(gh.asked.length).toBe(reads)
    expect(linked.map(l => [l.id, l.board, l.boardTitle, l.card?.title])).toEqual([
      ['CORK-2', 'cork', undefined, 'Beside'],
      ['ART-1', 'art', 'Art', 'Drawn'],
      ['GAME-1', 'game', 'Game', undefined],
      ['GONE-9', undefined, undefined, undefined],
    ])
  })
})
