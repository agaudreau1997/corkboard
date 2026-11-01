// A card's linked cards, for its screen. A link can name a card of any board of the repo; one on the
// open board is there already, and one on another board is found in the snapshot's tree and read
// from the cache when the phone has read that board before. Nothing is fetched for it: reading
// another board's cards would cost a query each time a card opens, for a title. A card the cache
// lacks still says which board it's on, and opening it reads that board as opening it there does.

import { tryParseCard } from '@shared/cardfile'
import type { Card } from '@shared/types'
import type { RepoCache, Snapshot } from './cache'
import { parseMeta } from './layout'
import type { Board } from './reader'

export type Linked = {
  id: string
  /** The board it's on, when the repo has it. */
  board?: string
  /** That board's title, when it isn't the open one. */
  boardTitle?: string
  /** The card, when it's on the open board or its file is cached. */
  card?: Card
}

/** The cards `ids` names, as far as the open board and the cache know them. */
export function linkedCards(
  cache: RepoCache,
  snapshot: Snapshot | undefined,
  open: Pick<Board, 'path' | 'cards'> | undefined,
  ids: string[],
): Linked[] {
  return ids.map(id => {
    const here = open?.cards.find(c => c.id === id)
    if (here && open) return { id, board: open.path, card: here }
    for (const files of snapshot?.boards ?? []) {
      const file = files.cards.find(c => c.id === id)
      if (!file) continue
      const text = cache.blob(file.sha)
      const card = text === undefined ? undefined : tryParseCard(text, id)
      const title = parseMeta(cache.blob(files.meta.sha) ?? '')?.title
      return { id, board: files.path, boardTitle: title || files.path, ...(card ? { card } : {}) }
    }
    return { id }
  })
}
