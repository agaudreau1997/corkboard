import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discussPrompt, sessionName } from '@shared/prompts'
import type { BoardMeta, Card } from '@shared/types'
import { BoardStore } from '../src/main/store'
import { tackle } from '../src/main/tackle'

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'corkboard-discuss-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A terminal that records what it was asked to run. */
function fakePtys() {
  const runs: string[][] = []
  return {
    runs,
    ptys: {
      create: (opts: { command?: string[]; title: string; cwd: string }) => {
        runs.push(opts.command ?? [])
        return { id: String(runs.length), title: opts.title, cwd: opts.cwd }
      },
      listen: () => () => {},
    } as never,
  }
}

const meta: BoardMeta = {
  key: 'G',
  title: 'Game',
  lists: [
    { id: 'todo', title: 'To do' },
    { id: 'doing', title: 'Doing' },
    { id: 'done', title: 'Done' },
  ],
  flow: { doing: 'doing', done: 'done' },
}

const card = (id: string, title: string, body = ''): Card => ({
  id, title, body, list: 'todo', pos: 1, labels: [], links: [], sessions: [], extra: {},
})

describe('discuss prompts', () => {
  const ctx = {
    meta,
    boardRoot: '/b',
    cardFile: (id: string) => `/b/game/cards/${id}.md`,
    linkTitle: () => undefined,
    cloud: false,
  }

  it('one card: talk it through, implement nothing, edit only the card', () => {
    const prompt = discussPrompt([card('G-1', 'Turrets', 'Maybe on the walls?')], ctx)
    expect(prompt.startsWith("Let's discuss card G-1 from the task board: Turrets")).toBe(true)
    expect(prompt).toContain('Maybe on the walls?')
    expect(prompt).toContain('/b/game/cards/G-1.md')
    expect(prompt).toContain('Do not implement anything')
    expect(prompt).toContain('unless I explicitly ask')
    expect(prompt).toContain('the only files you may edit without asking')
    // Nothing a tackle asks for: no trailer, no move to done.
    expect(prompt).not.toContain('Card: G-1')
    expect(prompt).not.toContain('list: done')
  })

  it('a list: triage, each card weighed, the person decides', () => {
    const prompt = discussPrompt([card('G-1', 'Turrets'), card('G-2', 'Traps')], { ...ctx, listTitle: 'To do' })
    expect(prompt.startsWith(`Let's triage these 2 cards in the "To do" list`)).toBe(true)
    expect(prompt.indexOf('1. G-1')).toBeLessThan(prompt.indexOf('2. G-2'))
    expect(prompt).toContain('Propose; I decide.')
    expect(prompt).toContain('Do not implement anything')
  })

  it('a whole board: triage, each card with the list it sits in', () => {
    const idea = { ...card('G-3', 'Weather'), list: null }
    const prompt = discussPrompt([card('G-1', 'Turrets'), { ...card('G-2', 'Traps'), list: 'doing' }, idea], {
      ...ctx,
      boardTitle: 'Game',
    })
    expect(prompt.startsWith(`Let's triage the whole "Game" board of the task board, its 3 cards:`)).toBe(true)
    expect(prompt).toContain('1. G-1: Turrets\n   List: To do\n   File: /b/game/cards/G-1.md')
    expect(prompt).toContain('2. G-2: Traps\n   List: Doing')
    expect(prompt).toContain('3. G-3: Weather\n   List: map only (idea)')
    expect(prompt).toContain('Propose; I decide.')
    expect(prompt).toContain('Do not implement anything')
  })

  it('in Claude desktop: names the folder, one card or a list', () => {
    const one = discussPrompt([card('G-1', 'Turrets')], { ...ctx, workDir: '/code' })
    const list = discussPrompt([card('G-1', 'a'), card('G-2', 'b')], { ...ctx, listTitle: 'To do', workDir: '/code' })
    for (const prompt of [one, list]) expect(prompt).toContain('if your working directory is not /code, move the session there first')
    expect(discussPrompt([card('G-1', 'Turrets')], ctx)).not.toContain('Work in')
  })

  it('a list names no list per card', () => {
    const prompt = discussPrompt([card('G-1', 'a'), card('G-2', 'b')], { ...ctx, listTitle: 'To do' })
    expect(prompt).not.toContain('List:')
  })

  it('names the session for what it is', () => {
    expect(sessionName([card('G-1', 'a'), card('G-2', 'b')], 'Game', 'discuss')).toBe('Triage Game (2 cards)')
    expect(sessionName([card('G-1', 'Turrets')], undefined, 'discuss')).toBe('Discuss G-1 Turrets')
    expect(sessionName([card('G-1', 'a'), card('G-2', 'b')], 'To do', 'discuss')).toBe('Triage To do (2 cards)')
  })
})

describe('starting a discussion', () => {
  it('leaves the cards in their list, records a discussion, and runs one session for a list', async () => {
    const store = new BoardStore(root)
    await store.init()
    const p = await store.createBoard('', 'Game', 'G')
    await store.createCard(p, { title: 'Turrets', list: 'todo' })
    await store.createCard(p, { title: 'Traps', list: 'todo' })
    const { ptys, runs } = fakePtys()

    await tackle({ boardPath: p, cardIds: ['G-1', 'G-2'], mode: 'local', split: 'each', purpose: 'discuss', listTitle: 'To do' }, store, ptys, async () => {})
    expect(runs.length).toBe(1)
    expect(runs[0].at(-1)).toContain("Let's triage these 2 cards")
    for (const id of ['G-1', 'G-2']) {
      const c = store.board(p).cards.find(x => x.id === id)!
      expect(c.list).toBe('todo')
      expect(c.sessions).toMatchObject([{ kind: 'local', purpose: 'discuss', name: 'Triage To do (2 cards)' }])
    }

    // A tackle of the same card does move it to the doing list.
    await tackle({ boardPath: p, cardIds: ['G-1'], mode: 'local' }, store, ptys, async () => {})
    expect(store.board(p).cards.find(x => x.id === 'G-1')!.list).toBe('doing')
  })

  it('refuses a discussion in the cloud or a worktree', async () => {
    const store = new BoardStore(root)
    await store.init()
    const p = await store.createBoard('', 'Game', 'G')
    await store.createCard(p, { title: 'Turrets', list: 'todo' })
    const { ptys } = fakePtys()
    await expect(tackle({ boardPath: p, cardIds: ['G-1'], mode: 'cloud', purpose: 'discuss' }, store, ptys, async () => {})).rejects.toThrow()
  })
})
