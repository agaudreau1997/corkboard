import { describe, expect, it } from 'vitest'
import {
  between,
  isDivider,
  LIST_COLORS,
  listSort,
  orderList,
  parseCard,
  reorderLists,
  serializeCard,
  slugify,
  sortCards,
} from '@shared/cardfile'
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
      jira: 'SPDI-42',
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

  it('reads a jira key written by hand and writes it among the known keys', () => {
    const card = parseCard('---\nid: RS-1\ntitle: x\nlist: todo\npos: 1\njira: spdi-7\n---\n')
    expect(card.jira).toBe('spdi-7')
    expect(card.extra).toEqual({})
    expect(serializeCard({ ...base, jira: 'SPDI-7', trello: 'https://t' })).toContain('\njira: SPDI-7\ntrello: https://t\n')
    expect(serializeCard(base)).not.toContain('jira')
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

  it('defaults the done list to last updated and every other list to manual', () => {
    const meta = { flow: { doing: 'doing', done: 'done' } }
    expect(listSort(meta, { id: 'done' })).toBe('updated')
    expect(listSort(meta, { id: 'todo' })).toBe('manual')
    expect(listSort(meta, { id: 'doing' })).toBe('manual')
    expect(listSort(meta, undefined)).toBe('manual')
    // A board with no done list has every list manual; a sort board.json names always wins.
    expect(listSort({}, { id: 'done' })).toBe('manual')
    expect(listSort(meta, { id: 'done', sort: 'manual' })).toBe('manual')
    expect(listSort(meta, { id: 'todo', sort: 'title' })).toBe('title')
  })

  it('orders a list by its sort', () => {
    const cards = [
      { ...base, id: 'RS-1', pos: 1, title: 'b', created: '2026-01-01', updated: '2026-03-01' },
      { ...base, id: 'RS-2', pos: 2, title: 'a', created: '2026-01-02', updated: '2026-03-03' },
      { ...base, id: 'RS-3', pos: 3, title: 'c', created: '2026-01-03', updated: '2026-03-02' },
    ]
    const ids = (sort: Parameters<typeof orderList>[1]) => orderList(cards, sort).map(c => c.id)
    expect(ids('updated')).toEqual(['RS-2', 'RS-3', 'RS-1'])
    expect(ids('manual')).toEqual(['RS-1', 'RS-2', 'RS-3'])
    expect(ids('newest')).toEqual(['RS-3', 'RS-2', 'RS-1'])
    expect(ids('oldest')).toEqual(['RS-1', 'RS-2', 'RS-3'])
    expect(ids('title')).toEqual(['RS-2', 'RS-1', 'RS-3'])
    // A card that changes takes its place with no write to pos.
    const touched = cards.map(c => (c.id === 'RS-1' ? { ...c, updated: '2026-04-01' } : c))
    expect(orderList(touched, 'updated').map(c => c.id)).toEqual(['RS-1', 'RS-2', 'RS-3'])
    // A card never changed since it was made counts from its creation.
    const fresh = [...cards, { ...base, id: 'RS-4', pos: 4, created: '2026-03-04' }]
    expect(orderList(fresh, 'updated')[0].id).toBe('RS-4')
  })

  it('sorts a list between its dividers, which stay put', () => {
    const cards = [
      { ...base, id: 'RS-1', pos: 1, updated: '2026-03-01' },
      { ...base, id: 'RS-2', pos: 2, updated: '2026-03-02' },
      { ...base, id: 'RS-3', pos: 3, title: '---', updated: '2026-03-09' },
      { ...base, id: 'RS-4', pos: 4, updated: '2026-03-03' },
      { ...base, id: 'RS-5', pos: 5, updated: '2026-03-04' },
    ]
    expect(orderList(cards, 'updated').map(c => c.id)).toEqual(['RS-2', 'RS-1', 'RS-3', 'RS-5', 'RS-4'])
  })

  it('reorders lists around the archived ones, which keep their places', () => {
    const lists = [
      { id: 'a', title: 'A' },
      { id: 'old', title: 'Old', archived: true },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ]
    const moved = reorderLists(lists, 'c', 'a')!
    expect(moved.map(l => l.id)).toEqual(['c', 'old', 'a', 'b'])
    // Each list keeps the colour it had at its old place.
    expect(moved.find(l => l.id === 'c')?.color).toBe(LIST_COLORS[3])
    expect(moved.find(l => l.id === 'a')?.color).toBe(LIST_COLORS[0])
    expect(reorderLists(moved, 'a', 'c')?.find(l => l.id === 'a')?.color).toBe(LIST_COLORS[0])
    expect(reorderLists(lists, 'a', 'c')?.map(l => l.id)).toEqual(['b', 'old', 'c', 'a'])
    expect(reorderLists(lists, 'b', 'b')).toBeNull()
    expect(reorderLists(lists, 'old', 'a')).toBeNull()
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

  it('in Claude desktop: names the folder, which the session checks first and moves to', () => {
    const prompt = tacklePrompt([base], { ...ctx, workDir: '/code' })
    expect(prompt).toContain('Work in /code.')
    // The app starts a link's session with no folder when its branch is left blank.
    expect(prompt).toContain("if your working directory is not /code, move the session there first, with the desktop app's change_directory tool")
    expect(prompt).toContain("If you can't, stop and tell me")
    expect(tacklePrompt([base], ctx)).not.toContain('Work in')
  })

  it('appends the board prompt notes', () => {
    const prompt = tacklePrompt([base], { ...ctx, meta: { ...meta, promptNotes: 'Use opus-xhigh.' } })
    expect(prompt.endsWith('Use opus-xhigh.')).toBe(true)
  })
})

describe('work-mode tackle prompts', () => {
  const meta: BoardMeta = {
    key: 'RS',
    title: 'Client portal',
    lists: [
      { id: 'todo', title: 'todo' },
      { id: 'done', title: 'Done' },
    ],
    flow: { done: 'done' },
  }
  const ctx = {
    meta,
    boardRoot: '/b',
    cardFile: (id: string) => `/b/portal/cards/${id}.md`,
    linkTitle: (id: string) => (id === 'RS-12' ? 'Turrets' : id === 'RS-13' ? 'Traps' : undefined),
    linkKey: (id: string) => (id === 'RS-12' ? 'SPDI-12' : undefined),
    cloud: false,
    work: true,
  }
  const card: Card = { ...base, jira: 'SPDI-42', links: ['RS-12', 'RS-13', 'RS-99'] }
  /** Every card id of the board, wherever it is: the thing a work prompt must not spread. */
  const ids = (text: string) => text.match(/\bRS-\d+\b/g) ?? []
  const rule = 'Never write a card id of the task board'

  it('locally: the key opens it, the id is only in the file path and the related cards, next to the rule', () => {
    const prompt = tacklePrompt([card], ctx)
    expect(prompt.startsWith('Tackle SPDI-42 from the task board: Add occlusion culling')).toBe(true)
    expect(prompt).toContain('Name the Jira key SPDI-42 in every commit message, in the branch name and in the PR title.')
    expect(prompt).toContain(rule)
    expect(prompt).toContain("overrides the board repo's CLAUDE.md")
    expect(prompt).not.toContain('Card: RS-886')
    expect(prompt).toContain('/b/portal/cards/RS-886.md')
    expect(prompt).toContain('- RS-12: Turrets (SPDI-12)\n- RS-13: Traps\n- RS-99')
    // The only ids: the file path and the related cards.
    expect(ids(prompt.replace('/b/portal/cards/RS-886.md', '').replace(/^- RS-\d+.*$/gm, ''))).toEqual([])
    expect(prompt).toContain('`list: done`')
  })

  it('in the cloud: no card id at all, related cards by title and key', () => {
    const prompt = tacklePrompt([card], { ...ctx, cloud: true })
    expect(ids(prompt)).toEqual([])
    expect(prompt).toContain('Related cards:\n- Turrets (SPDI-12)\n- Traps')
    expect(prompt).not.toContain('RS-99')
    expect(prompt).toContain('Name the Jira key SPDI-42')
    expect(prompt).toContain(rule)
    expect(prompt).not.toContain('jira: <KEY>')
  })

  it('without a key: the title opens it, the session asks for the key and writes it into the card', () => {
    const local = tacklePrompt([{ ...base, links: [] }], ctx)
    expect(local.startsWith('Tackle this card from the task board: Add occlusion culling')).toBe(true)
    expect(local).toContain('This card has no Jira key yet: ask me for it before your first commit')
    expect(local).toContain('`jira: <KEY>`')
    expect(local).toContain(rule)
    expect(ids(local.replace('/b/portal/cards/RS-886.md', ''))).toEqual([])
    const cloud = tacklePrompt([{ ...base, links: [] }], { ...ctx, cloud: true })
    expect(ids(cloud)).toEqual([])
    expect(cloud).toContain('ask me for it before your first commit, then name it')
    expect(cloud).not.toContain('jira: <KEY>')
  })

  it('several cards: each by its key or title, the rule for all', () => {
    const cards = [card, { ...base, id: 'RS-12', title: 'Turrets', jira: 'SPDI-12' }, { ...base, id: 'RS-13', title: 'Traps' }]
    const local = tacklePrompt(cards, { ...ctx, listTitle: 'Sprint 4' })
    expect(local).toContain('1. SPDI-42: Add occlusion culling')
    expect(local).toContain('2. SPDI-12: Turrets')
    expect(local).toContain('3. Traps\n   File: /b/portal/cards/RS-13.md')
    expect(local).toContain("Name each card's Jira key in every commit message for it")
    expect(local).toContain('A card with no Jira key yet: ask me for it before its first commit')
    expect(local).not.toContain('Card: <ID>')
    const cloud = tacklePrompt(cards.map(c => ({ ...c, links: [] })), { ...ctx, cloud: true })
    expect(ids(cloud)).toEqual([])
  })

  it('a personal project is as before', () => {
    const prompt = tacklePrompt([card], { ...ctx, work: false })
    expect(prompt.startsWith('Tackle card RS-886 from the task board')).toBe(true)
    expect(prompt).toContain('`Card: RS-886`')
    expect(prompt).not.toContain('Jira')
    expect(prompt).toContain('- RS-12: Turrets\n- RS-13: Traps\n- RS-99')
  })
})

describe('worktree names', () => {
  it('a personal project: the card id, or the list', async () => {
    const { worktreeName } = await import('../src/main/tackle')
    expect(worktreeName([base])).toBe('card-rs-886')
    expect(worktreeName([base, { ...base, id: 'RS-12' }], 'Sprint 4')).toMatch(/^cards-sprint-4-\d{8}$/)
    expect(worktreeName([base, { ...base, id: 'RS-12' }])).toMatch(/^cards-rs-886-\d{8}$/)
  })

  it('a work project: the Jira key as written, else the title or the list, never a card id', async () => {
    const { worktreeName } = await import('../src/main/tackle')
    expect(worktreeName([{ ...base, jira: 'SPDI-42' }], undefined, true)).toBe('SPDI-42')
    expect(worktreeName([base], undefined, true)).toBe('add-occlusion-culling-take-it-from-the-gdvmf-2-3')
    const two = [{ ...base, jira: 'SPDI-42' }, { ...base, id: 'RS-12', jira: 'SPDI-12' }]
    expect(worktreeName(two, 'Sprint 4', true)).toBe('SPDI-42-SPDI-12')
    const mixed = [{ ...base, jira: 'SPDI-42' }, { ...base, id: 'RS-12', title: 'Turrets' }]
    expect(worktreeName(mixed, 'Sprint 4', true)).toMatch(/^cards-sprint-4-\d{8}$/)
    expect(worktreeName(mixed, undefined, true)).toMatch(/^cards-add-occlusion-culling-ta-\d{8}$/)
  })
})

describe('the local session command', () => {
  /** Claude Code's grammar for these flags: --add-dir is variadic, the others take one value. */
  function parse(argv: string[]) {
    const out: { dirs: string[]; prompt?: string; opts: Record<string, string> } = { dirs: [], opts: {} }
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === '--add-dir') {
        while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) out.dirs.push(argv[++i])
      } else if (['-n', '--session-id', '-w'].includes(arg)) {
        out.opts[arg] = argv[++i]
      } else {
        out.prompt = arg
      }
    }
    return out
  }

  it('keeps the prompt out of --add-dir, with and without a worktree', async () => {
    const { localCommand } = await import('../src/main/tackle')
    for (const worktree of [undefined, 'card-rs-961']) {
      const argv = localCommand({ claude: 'claude', boardRoot: '/b', name: 'RS-961 x', sessionId: 'id', worktree, prompt: 'Tackle card RS-961' })
      const parsed = parse(argv)
      expect(parsed.prompt).toBe('Tackle card RS-961')
      expect(parsed.dirs).toEqual(['/b'])
      expect(parsed.opts['-w']).toBe(worktree)
    }
  })
})
