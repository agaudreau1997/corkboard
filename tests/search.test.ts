// The filter over a board, the desktop's and the companion's: id, title or description, any case.

import { describe, expect, it } from 'vitest'
import { cardMatcher } from '@shared/search'

const card = { id: 'CORK-12', title: 'Fix the Login', body: 'It forgets the session.' }

describe('finding a card', () => {
  it('matches the id, the title or the description, ignoring case and spaces around', () => {
    expect(cardMatcher('cork-12')(card)).toBe(true)
    expect(cardMatcher('  LOGIN ')(card)).toBe(true)
    expect(cardMatcher('session')(card)).toBe(true)
    expect(cardMatcher('logout')(card)).toBe(false)
  })

  it('matches every card when there is no text', () => {
    expect(cardMatcher('')(card)).toBe(true)
    expect(cardMatcher('   ')(card)).toBe(true)
  })
})
