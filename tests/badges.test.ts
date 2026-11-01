import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { badgeChildren, badgeClass, badgeText, cardBadges } from '@shared/badges'
import { FONT_TOKENS } from '@shared/fonts'
import type { Card, SessionRef } from '@shared/types'

const card = (fields: Partial<Card> & { id: string }): Card => ({
  title: fields.id,
  list: 'todo',
  pos: 1024,
  labels: [],
  links: [],
  after: [],
  sessions: [],
  body: '',
  extra: {},
  ...fields,
})

const session = (purpose?: 'discuss'): SessionRef => ({ kind: 'local', started: '2026-11-01T00:00:00Z', purpose })
const noon = new Date(2026, 10, 2, 12, 0)
const meta = { flow: { doing: 'doing', done: 'done' } }

describe('card badges', () => {
  it('a bare card has none', () => {
    expect(cardBadges(card({ id: 'A-1' }), { cards: [], meta })).toEqual([])
  })

  it('lists them in the face order, with their tones', () => {
    const before = card({ id: 'A-1' })
    const c = card({
      id: 'A-2',
      body: 'Notes\n',
      links: ['A-9', 'B-3'],
      after: ['A-1'],
      due: '2026-11-01',
      sessions: [session(), session(), session('discuss')],
    })
    const badges = cardBadges(c, { cards: [before, c], meta }, { commits: 3, now: noon })
    expect(badges.map(b => [badgeText(b), badgeClass(b)])).toEqual([
      ['≡', 'badge'],
      ['⛓ 2', 'badge'],
      ['⧗ 1', 'badge waits'],
      ['⎇ 3', 'badge commit'],
      ['▶ 2', 'badge session'],
      ['✎ 1', 'badge discuss'],
      ['⏰ 2026-11-01', 'badge overdue'],
    ])
    expect(badges.find(b => b.key === 'waits')!.title).toBe('Waits on A-1, not done yet')
    expect(badges.find(b => b.key === 'due')!.title).toBe('Past due')
    expect(badges.map(badgeChildren).slice(0, 2)).toEqual([['≡'], ['⛓ ', '2']])
  })

  it('leaves the commits out without a count, as on the phone', () => {
    expect(cardBadges(card({ id: 'A-1', body: 'x' }), { cards: [], meta }).map(b => b.key)).toEqual(['body'])
    expect(cardBadges(card({ id: 'A-1' }), { cards: [], meta }, { commits: 0 })).toEqual([])
  })

  it('a done card keeps its sessions, waits and lateness in the drawer', () => {
    const open = card({ id: 'A-1' })
    for (const c of [
      card({ id: 'A-2', complete: true, sessions: [session()], after: ['A-1'], due: '2026-10-01' }),
      card({ id: 'A-3', list: 'done', sessions: [session('discuss')], after: ['A-1'], due: '2026-10-01' }),
    ]) {
      const badges = cardBadges(c, { cards: [open, c], meta }, { now: noon })
      expect(badges.map(b => b.key)).toEqual(c.complete ? ['complete', 'due'] : ['due'])
      expect(badges.find(b => b.key === 'due')!.tone).toBeUndefined()
    }
    expect(cardBadges(card({ id: 'A-2', complete: true }), { cards: [], meta })[0]).toMatchObject({ glyph: '✓', tone: 'ok' })
  })

  it('a card waits only on cards of its board that are still open', () => {
    const c = card({ id: 'A-4', after: ['A-1', 'A-2', 'A-3', 'Z-1'] })
    const cards = [card({ id: 'A-1', complete: true }), card({ id: 'A-2', list: 'done' }), card({ id: 'A-3', archived: true }), c]
    expect(cardBadges(c, { cards, meta })).toEqual([])
  })
})

describe('the shared type', () => {
  it('is the stylesheet’s own', () => {
    const css = readFileSync(path.join(__dirname, '../src/renderer/src/styles.css'), 'utf8')
    const root = /:root\s*\{([^}]*)\}/.exec(css)![1]
    for (const [name, value] of Object.entries(FONT_TOKENS)) {
      expect(new RegExp(`${name}:\\s*([^;]*);`).exec(root)?.[1], name).toBe(value)
    }
  })
})
