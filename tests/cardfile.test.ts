import { describe, expect, it } from 'vitest'
import { between, isDivider, parseCard, serializeCard, slugify, sortCards } from '@shared/cardfile'
import { tacklePrompt, sessionName } from '@shared/prompts'
import type { BoardMeta, Card } from '@shared/types'

const base: Card = {
  id: 'RS-886',
  title: 'Add occlusion culling: take it from the gdvmf 2.3.0 PR?',
  list: 'todo',
  pos: 1024,
  labels: [],
  links: [],
  sessions: [],
  body: '',
  extra: {},
}

describe('card files', () => {
  it('round-trips every field, unknown keys included', () => {
    const card: Card = {
      ...base,
      created: '2026-09-20T12:28:50.000Z',
      complete: true,
      links: ['RS-12', 'IDEA-4'],
      sessions: [{ id: 'abc', kind: 'local', started: '2026-10-03T10:00:00.000Z', cards: ['RS-886'] }],
      body: '# Notes\n\n- one\n- two',
      extra: { estimate: 3 },
    }
    const text = serializeCard(card)
    expect(parseCard(text)).toEqual(card)
    expect(serializeCard(parseCard(text))).toBe(text)
  })

  it('writes the known keys first and leaves empty ones out', () => {
    const text = serializeCard(base)
    expect(text).toBe(
      '---\nid: RS-886\ntitle: "Add occlusion culling: take it from the gdvmf 2.3.0 PR?"\nlist: todo\npos: 1024\n---\n',
    )
  })

  it('reads a card written by hand, and a null list as an idea', () => {
    const card = parseCard('---\nid: IDEA-3\ntitle: Turrets\nlist:\n---\nSome text\n')
    expect(card.list).toBeNull()
    expect(card.body).toBe('Some text')
    expect(card.pos).toBe(0)
  })

  it('falls back to the file name for the id', () => {
    expect(parseCard('---\ntitle: x\nlist: a\n---\n', 'RS-1').id).toBe('RS-1')
  })

  it('keeps a move a one-line diff', () => {
    const before = serializeCard({ ...base, body: 'text' }).split('\n')
    const after = serializeCard({ ...base, body: 'text', list: 'done' }).split('\n')
    expect(before.filter((line, i) => line !== after[i])).toEqual(['list: todo'])
  })
})

describe('helpers', () => {
  it('positions between neighbours', () => {
    expect(between(undefined, undefined)).toBe(1024)
    expect(between(1024, undefined)).toBe(2048)
    expect(between(undefined, 1024)).toBe(512)
    expect(between(1024, 2048)).toBe(1536)
  })

  it('sorts by position, then by number', () => {
    const cards = [
      { ...base, id: 'RS-3', pos: 2 },
      { ...base, id: 'RS-2', pos: 1 },
      { ...base, id: 'RS-1', pos: 2 },
    ]
    expect(sortCards(cards).map(c => c.id)).toEqual(['RS-2', 'RS-1', 'RS-3'])
  })

  it('knows dividers and slugs', () => {
    expect(isDivider({ title: '---' })).toBe(true)
    expect(isDivider({ title: ' ------ ' })).toBe(true)
    expect(isDivider({ title: '-- not' })).toBe(false)
    expect(slugify('Tutorial 2 (the cattening)')).toBe('tutorial-2-the-cattening')
  })
})

describe('tackle prompts', () => {
  const meta: BoardMeta = {
    key: 'RS',
    title: 'Robot shooter',
    lists: [
      { id: 'todo', title: 'todo' },
      { id: 'done', title: 'Done' },
    ],
    flow: { done: 'done' },
  }
  const ctx = {
    meta,
    boardRoot: '/b',
    cardFile: (id: string) => `/b/robot-shooter/cards/${id}.md`,
    linkTitle: (id: string) => (id === 'RS-12' ? 'Turrets' : undefined),
    cloud: false,
  }

  it('one card, locally: the card, its file, the trailer and the move', () => {
    const prompt = tacklePrompt([{ ...base, body: 'Look at the PR.', links: ['RS-12'] }], ctx)
    expect(prompt).toContain('Tackle card RS-886 from the task board: Add occlusion culling')
    expect(prompt).toContain('Look at the PR.')
    expect(prompt).toContain('- RS-12: Turrets')
    expect(prompt).toContain('/b/robot-shooter/cards/RS-886.md')
    expect(prompt).toContain('`Card: RS-886`')
    expect(prompt).toContain('`list: done`')
    expect(prompt).toContain("Don't commit in the board repo")
  })

  it('a list: numbered, in order, moved one at a time', () => {
    const cards = [base, { ...base, id: 'RS-12', title: 'Turrets' }]
    const prompt = tacklePrompt(cards, { ...ctx, listTitle: 'ToDoing Prime' })
    expect(prompt).toContain('Tackle these 2 cards from the "ToDoing Prime" list')
    expect(prompt.indexOf('1. RS-886')).toBeLessThan(prompt.indexOf('2. RS-12'))
    expect(prompt).toContain('before starting the next')
    expect(sessionName(cards, 'ToDoing Prime')).toBe('ToDoing Prime (2 cards)')
  })

  it('in the cloud: no local paths and no board edits', () => {
    const prompt = tacklePrompt([base], { ...ctx, cloud: true })
    expect(prompt).not.toContain('/b/')
    expect(prompt).not.toContain('list: done')
    expect(prompt).toContain('`Card: RS-886`')
  })

  it('without a done list, says nothing about moving', () => {
    const prompt = tacklePrompt([base], { ...ctx, meta: { ...meta, flow: undefined } })
    expect(prompt).not.toContain('list:')
  })

  it('appends the board prompt notes', () => {
    const prompt = tacklePrompt([base], { ...ctx, meta: { ...meta, promptNotes: 'Use opus-xhigh.' } })
    expect(prompt.endsWith('Use opus-xhigh.')).toBe(true)
  })
})
