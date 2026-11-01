// Finding cards by text: the desktop's filter over a board and the companion's search use this
// one rule, so a card found on one is found on the other. A card matches when its id, title or
// description holds the text, ignoring case; no text matches every card.

import type { Card } from './types'

/** Whether a card matches the query, as a reusable test (built once per query). */
export function cardMatcher(query: string): (card: Pick<Card, 'id' | 'title' | 'body'>) => boolean {
  const q = query.trim().toLowerCase()
  if (!q) return () => true
  return card => card.id.toLowerCase().includes(q) || card.title.toLowerCase().includes(q) || card.body.toLowerCase().includes(q)
}
