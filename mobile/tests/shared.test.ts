// The companion builds `src/shared/` with its own toolchain and its own `yaml`: these check that
// what it reads and writes is the desktop's format, and that it paints with the desktop's tokens.

import { describe, expect, it } from 'vitest'
import { parseCard, serializeCard } from '@shared/cardfile'
import { TOKEN_NAMES } from '@shared/theme'
import { tokens } from '../src/theme'

describe('the companion and src/shared', () => {
  it('round-trips a card file unchanged', () => {
    const text = [
      '---',
      'id: CORK-7',
      'title: Jot it down',
      'list: todo',
      'pos: 1024',
      'created: 2026-11-01T20:00:00.000Z',
      'uid: 0f8e2c1a-5b7d-4e3f-9a6b-2c4d8e1f0a3b',
      'mood: kept as it was',
      '---',
      '',
      'From the phone.',
      '',
    ].join('\n')
    const card = parseCard(text)
    expect(card.title).toBe('Jot it down')
    expect(serializeCard(card)).toBe(text)
  })

  it('sets every token the desktop has, at its values', () => {
    const set = tokens()
    for (const name of TOKEN_NAMES) expect(set[name], name).toMatch(/^#[0-9a-f]{6}$/)
    expect(set['--bg']).toBe('#15171c')
    expect(set['--accent']).toBe('#f0c674')
  })

  it('lets a theme override a base colour', () => {
    expect(tokens({ colors: { accent: '#ff0000' } })['--accent']).toBe('#ff0000')
  })
})
