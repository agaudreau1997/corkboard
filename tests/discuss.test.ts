import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discussPrompt, sessionName, untanglePrompt } from '@shared/prompts'
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
      create: (opts: { command?: string[]; title: string; cwd: string; boardKey?: string }) => {
        runs.push(opts.command ?? [])
        return { id: String(runs.length), title: opts.title, cwd: opts.cwd, boardKey: opts.boardKey }
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
  id, title, body, list: 'todo', pos: 1, labels: [], links: [], after: [], sessions: [], extra: {},
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

  it('in work mode: no card id but in file paths, and the Jira rule for when it is asked to implement', () => {
    const work = { ...ctx, work: true }
    const one = discussPrompt([{ ...card('G-1', 'Turrets'), jira: 'SPDI-9' }], work)
    expect(one.startsWith("Let's discuss SPDI-9 from the task board: Turrets")).toBe(true)
    expect(one).toContain('/b/game/cards/G-1.md')
    expect(one).toContain('If I do ask you to implement something: Name the Jira key SPDI-9')
    expect(one).toContain('Never write a card id of the task board')
    expect(one.replace('/b/game/cards/G-1.md', '')).not.toMatch(/\bG-\d+\b/)
    const list = discussPrompt([card('G-1', 'Turrets'), { ...card('G-2', 'Traps'), jira: 'SPDI-2' }], { ...work, listTitle: 'To do' })
    expect(list).toContain('1. Turrets\n   File: /b/game/cards/G-1.md')
    expect(list).toContain('2. SPDI-2: Traps')
    expect(list).toContain("Name each card's Jira key")
    expect(list.replace(/File: .*$/gm, '')).not.toMatch(/\bG-\d+\b/)
    // A personal project's discussion says nothing of Jira.
    expect(discussPrompt([card('G-1', 'Turrets')], ctx)).not.toContain('Jira')
  })

  it('with the MCP server: agreed changes go through the tools, never the file, in both modes', () => {
    const one = discussPrompt([card('G-1', 'Turrets')], { ...ctx, mcp: true })
    expect(one).toContain('change the card with the corkboard tools')
    expect(one).toContain('never by editing its file')
    expect(one).not.toContain('ISO UTC')
    expect(one).toContain('Do not commit in the board repo')
    expect(one).toContain('Do not implement anything')
    const work = discussPrompt([card('G-1', 'Turrets')], { ...ctx, mcp: true, work: true })
    expect(work).toContain('change the card with the corkboard tools')
    expect(work).toContain('ask me for it before your first commit and set it on the card with update_card (`jira`)')
    expect(work).toContain('Never write a card id of the task board')
    expect(work.replace('/b/game/cards/G-1.md', '')).not.toMatch(/\bG-\d+\b/)
    // Without the server, the file rules.
    expect(discussPrompt([card('G-1', 'Turrets')], ctx)).toContain('write it into the card file')
  })

  it("asks for an agreed order to go in the later card's after, with the tools or in the file", () => {
    const cards = [card('G-1', 'Turrets'), card('G-2', 'Traps')]
    for (const prompt of [discussPrompt(cards, ctx), discussPrompt(cards, { ...ctx, mcp: true }), discussPrompt(cards, { ...ctx, work: true })]) {
      expect(prompt).toContain("record it in the later card's `after`")
    }
    expect(discussPrompt(cards, { ...ctx, mcp: true })).toContain('update_card for its description, title, links and `after`')
    expect(discussPrompt(cards, ctx)).toContain('(description, title, links, `after`, list,')
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
    const [opened] = await tackle({ boardPath: p, cardIds: ['G-1'], mode: 'local' }, store, ptys, async () => {}, `game:${p}`)
    expect(store.board(p).cards.find(x => x.id === 'G-1')!.list).toBe('doing')
    // Its terminal knows the board it works for, so it wears that project's colours.
    expect(opened.boardKey).toBe(`game:${p}`)
  })

  it('hands the MCP config to a terminal or worktree session only, its prompt telling it to use the tools', async () => {
    const store = new BoardStore(root)
    await store.init()
    const p = await store.createBoard('', 'Game', 'G')
    await store.createCard(p, { title: 'Turrets', list: 'todo' })
    const { ptys, runs } = fakePtys()
    const open = async () => {}
    for (const mode of ['local', 'local-worktree'] as const) {
      await tackle({ boardPath: p, cardIds: ['G-1'], mode }, store, ptys, open, undefined, '/profile/mcp.json')
      const argv = runs.at(-1)!
      expect(argv[argv.indexOf('--mcp-config') + 1]).toBe('/profile/mcp.json')
      expect(argv.at(-1)).toContain('corkboard tools')
    }
    await tackle({ boardPath: p, cardIds: ['G-1'], mode: 'local', purpose: 'discuss' }, store, ptys, open, undefined, '/profile/mcp.json')
    expect(runs.at(-1)).toContain('--mcp-config')
    expect(runs.at(-1)!.at(-1)).toContain('change the card with the corkboard tools')
    // The cloud can't reach this machine: no config, and the prompt has no tools in it.
    await tackle({ boardPath: p, cardIds: ['G-1'], mode: 'cloud' }, store, ptys, open, undefined, '/profile/mcp.json')
    expect(runs.at(-1)).not.toContain('--mcp-config')
    expect(runs.at(-1)!.at(-1)).not.toContain('corkboard tools')
    // With no server running, a terminal session gets the file rules.
    await tackle({ boardPath: p, cardIds: ['G-1'], mode: 'local' }, store, ptys, open)
    expect(runs.at(-1)).not.toContain('--mcp-config')
    expect(runs.at(-1)!.at(-1)).not.toContain('corkboard tools')
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

describe('untangle prompts', () => {
  // G-2 was made on both machines; this one's is now G-3.
  const mine = { ...card('G-3', 'Turrets on the walls', 'Mount them high.'), uid: 'uid-b', renumbered: [{ from: 'G-2', at: '2026-11-01T10:00:00.000Z' }] }
  const theirs = card('G-2', 'Traps in the corridor', 'Spikes, mostly.')
  const ctx = {
    meta,
    boardRoot: '/b',
    cardFile: (id: string) => `/b/game/cards/${id}.md`,
    linkTitle: () => undefined,
    findCard: (id: string) => (id === 'G-2' ? theirs : undefined),
    codeRepo: '/code',
    cloud: false,
    mcp: true,
  }

  it('names each renumber, both cards in full, and fixes only what means the renumbered card', () => {
    const prompt = untanglePrompt([mine], ctx)
    expect(prompt).toContain('A sync of the task board renumbered a card')
    expect(prompt).toContain('1. G-2 is now G-3 (uid uid-b).')
    expect(prompt).toContain('The renumbered card, now G-3: Turrets on the walls\n   File: /b/game/cards/G-3.md\n      Mount them high.')
    expect(prompt).toContain('The card now under G-2, made on the other machine: Traps in the corridor\n      Spikes, mostly.')
    expect(prompt).toContain('Decide from the context which card each mention means')
    expect(prompt).toContain('with the corkboard tools')
    expect(prompt).toContain("Ask me before anything you aren't sure of")
    expect(prompt).toContain("Don't commit in the board repo")
    // The code repo: trailers and branches found, unpushed ones proposed, pushed ones named on the card.
    expect(prompt).toContain('In the code repo /code')
    expect(prompt).toContain('`Card: G-2`')
    expect(prompt).toContain('git branch -r --contains')
    expect(prompt).toContain('change them only once I agree')
    expect(prompt).toContain("Leave pushed commits as they are: name them (short hash and subject) in the renumbered card's description")
    // Without the server, the file rules; without a code repo, no commits to look at.
    expect(untanglePrompt([mine], { ...ctx, mcp: false })).toContain('setting `updated:`')
    expect(untanglePrompt([mine], { ...ctx, codeRepo: undefined })).toContain('no code repo on this machine')
  })

  it('in work mode: no card id into the code repo, nothing there to fix', () => {
    const prompt = untanglePrompt([mine], { ...ctx, work: true })
    expect(prompt).toContain('This is a work project')
    expect(prompt).toContain("Don't change the code repo")
    expect(prompt).toContain('never write a card id of the task board')
    expect(prompt).toContain('put none')
    expect(prompt).not.toContain('`Card: G-2`')
    expect(prompt).not.toContain('git log')
    expect(prompt).not.toContain('/code')
    // The board side is the same: the board repo is where the ids live.
    expect(prompt).toContain('1. G-2 is now G-3')
    // A personal project's says nothing of Jira.
    expect(untanglePrompt([mine], ctx)).not.toContain('Jira')
  })

  it('several renumbers in one session, and a card no longer under the old id', () => {
    const other = { ...card('G-9', 'Lights'), renumbered: [{ from: 'G-4', at: '2026-11-01T10:00:00.000Z' }] }
    const prompt = untanglePrompt([mine, other], ctx)
    expect(prompt).toContain('renumbered 2 cards')
    expect(prompt).toContain('2. G-4 is now G-9.')
    expect(prompt).toContain('No card is under G-4 on this machine now')
    expect(prompt).toContain('`Card: G-2`, `Card: G-4`')
    expect(sessionName([mine], undefined, 'untangle')).toBe('Untangle G-3 Turrets on the walls')
  })
})

describe('starting an untangle', () => {
  it('runs in a terminal, leaves the card in its list, records the session, and wants a renumbered card', async () => {
    const store = new BoardStore(root)
    await store.init()
    const p = await store.createBoard('', 'Game', 'G')
    await store.createCard(p, { title: 'Traps', list: 'todo' })
    const made = await store.createCard(p, { title: 'Turrets', list: 'todo' })
    const { ptys, runs } = fakePtys()
    const open = async () => {}
    await expect(tackle({ boardPath: p, cardIds: [made.id], mode: 'local', purpose: 'untangle' }, store, ptys, open)).rejects.toThrow('renumbered')

    await store.updateCard(p, made.id, { renumbered: [{ from: 'G-1', at: '2026-11-01T10:00:00.000Z' }] })
    await tackle({ boardPath: p, cardIds: [made.id], mode: 'local', purpose: 'untangle' }, store, ptys, open, undefined, '/profile/mcp.json')
    expect(runs.at(-1)).toContain('--mcp-config')
    const prompt = runs.at(-1)!.at(-1)!
    expect(prompt).toContain('1. G-1 is now G-2')
    expect(prompt).toContain('The card now under G-1, made on the other machine: Traps')
    const after = store.board(p).cards.find(c => c.id === made.id)!
    expect(after.list).toBe('todo')
    expect(after.sessions).toMatchObject([{ kind: 'local', purpose: 'untangle', name: 'Untangle G-2 Turrets' }])
    for (const mode of ['desktop', 'cloud', 'local-worktree'] as const) {
      await expect(tackle({ boardPath: p, cardIds: [made.id], mode, purpose: 'untangle' }, store, ptys, open)).rejects.toThrow('terminal')
    }
  })
})
