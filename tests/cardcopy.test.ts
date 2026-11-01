// What a card is copied and shared as, on the desktop's Copy menu and the companion's share sheet:
// a personal project's text carries the card id, a work project's the Jira key and never the id.

import { describe, expect, it } from 'vitest'
import { cardCopies, cardMarkdown, cardShareText } from '@shared/cardcopy'

const card = { id: 'CORK-12', title: 'Fix the login', jira: 'SPDI-42', body: 'It forgets you.\n' }
const keyless = { ...card, jira: undefined }

describe('copying and sharing a card', () => {
  it('names the id in a personal project', () => {
    expect(cardCopies(card, false).map(c => [c.label, c.text])).toEqual([
      ['Identifier', 'CORK-12'],
      ['Title', 'Fix the login'],
      ['Commit trailer', 'Card: CORK-12'],
      ['Markdown', '[CORK-12] Fix the login'],
    ])
    expect(cardShareText(card, false, true)).toBe('[CORK-12] Fix the login\n\nIt forgets you.\n')
    expect(cardShareText(card, false, false)).toBe('Fix the login\n\nIt forgets you.\n')
  })

  it('names the Jira key, never the id, in what a work project may paste', () => {
    const copies = cardCopies(card, true)
    expect(copies.map(c => [c.label, c.text])).toEqual([
      ['Identifier', 'CORK-12'],
      ['Title', 'Fix the login'],
      ['Jira key', 'SPDI-42'],
      ['Markdown', '[SPDI-42] Fix the login'],
    ])
    // Only the identifier, asked for by name, carries the id.
    for (const c of copies.filter(c => c.kind !== 'id')) expect(`${c.text} ${c.hint ?? ''}`).not.toContain('CORK-12')
    for (const markdown of [true, false]) expect(cardShareText(card, true, markdown)).not.toContain('CORK-12')
    expect(cardShareText(card, true, true)).toBe('[SPDI-42] Fix the login\n\nIt forgets you.\n')
  })

  it('falls back to the title in a work project when the card has no key', () => {
    expect(cardMarkdown(keyless, true)).toBe('Fix the login')
    expect(cardCopies(keyless, true).map(c => c.label)).toEqual(['Identifier', 'Title', 'Markdown'])
    expect(cardShareText({ ...keyless, body: '' }, true, true)).toBe('Fix the login\n')
  })
})
