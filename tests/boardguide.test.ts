import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boardGuide } from '@shared/boardguide'
import { discussPrompt, tacklePrompt } from '@shared/prompts'
import type { BoardMeta, Card } from '@shared/types'
import { prepareBoardRepo } from '../src/main/projects'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'corkboard-guide-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const meta: BoardMeta = { key: 'G', title: 'Game', lists: [{ id: 'todo', title: 'To do' }] }
const card: Card = { id: 'G-1', title: 'Turrets', body: '', list: 'todo', pos: 1, labels: [], links: [], sessions: [], extra: {} }
const ctx = (guide: boolean) => ({
  meta,
  boardRoot: '/b',
  cardFile: (id: string) => `/b/game/cards/${id}.md`,
  linkTitle: () => undefined,
  cloud: false,
  guide,
})

describe('the board guide', () => {
  it('is titled with the repo and holds the rules a session needs', () => {
    const text = boardGuide('my-boards')
    expect(text.startsWith('# my-boards\n')).toBe(true)
    expect(text).toContain('never commit, pull or push in this repo')
    expect(text).toContain('`updated:`')
    expect(text).toContain('`archived: true`')
    expect(text).not.toMatch(/\/home\/|~\//)
  })

  it('a new board repo gets one beside its README', async () => {
    const root = path.join(dir, 'boards')
    await prepareBoardRepo(root)
    expect(existsSync(path.join(root, 'README.md'))).toBe(true)
    expect(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe(boardGuide('boards'))
  })

  it('a folder with a CLAUDE.md of its own keeps it', async () => {
    const root = path.join(dir, 'boards')
    mkdirSync(root)
    writeFileSync(path.join(root, 'CLAUDE.md'), 'mine\n')
    await prepareBoardRepo(root)
    expect(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe('mine\n')
  })

  it('the prompts point to it only when the repo has one', () => {
    for (const build of [tacklePrompt, discussPrompt]) {
      expect(build([card], ctx(true))).toContain('in the board repo /b (its CLAUDE.md describes the card format).')
      const without = build([card], ctx(false))
      expect(without).toContain('in the board repo /b.')
      expect(without).not.toContain('CLAUDE.md')
      expect(build([card, { ...card, id: 'G-2' }], ctx(false))).not.toContain('CLAUDE.md')
    }
  })
})
