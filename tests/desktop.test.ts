import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  continueUrl,
  findDesktopSession,
  importUrl,
  newSessionUrl,
  transcriptFile,
} from '../src/main/desktop'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'corkboard-desktop-'))
  process.env.CORKBOARD_DESKTOP_SESSIONS_DIR = path.join(dir, 'claude-code-sessions')
  process.env.CORKBOARD_CLAUDE_PROJECTS_DIR = path.join(dir, 'projects')
})

afterEach(() => {
  delete process.env.CORKBOARD_DESKTOP_SESSIONS_DIR
  delete process.env.CORKBOARD_CLAUDE_PROJECTS_DIR
  rmSync(dir, { recursive: true, force: true })
})

/** What the desktop app leaves behind for one session: its index entry and the CLI transcript. */
function desktopSession(opts: { local: string; cli: string; cwd: string; createdAt: number; firstPrompt: string }) {
  const index = path.join(dir, 'claude-code-sessions', 'account', 'org')
  mkdirSync(index, { recursive: true })
  writeFileSync(
    path.join(index, `${opts.local}.json`),
    JSON.stringify({ sessionId: opts.local, cliSessionId: opts.cli, cwd: opts.cwd, createdAt: opts.createdAt, title: 'x' }),
  )
  const transcript = transcriptFile(opts.cwd, opts.cli)
  mkdirSync(path.dirname(transcript), { recursive: true })
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: opts.firstPrompt }, sessionId: opts.cli })}\n`,
  )
}

describe('Claude desktop links', () => {
  it('opens a new Code session with the prompt and every folder', () => {
    const { url, marker } = newSessionUrl('Tackle card RS-961: fix "stuck" enemies\n\nmore', ['/code', '/board'])
    const parsed = new URL(url)
    expect(parsed.protocol).toBe('claude:')
    expect(parsed.host).toBe('code')
    expect(parsed.pathname).toBe('/new')
    expect(parsed.searchParams.get('q')).toBe('Tackle card RS-961: fix "stuck" enemies\n\nmore')
    expect(parsed.searchParams.getAll('folder')).toEqual(['/code', '/board'])
    expect(marker).toBe('Tackle card RS-961: fix "stuck" enemies')
  })

  it('hands a prompt too long for a link over in a file', () => {
    const long = `Tackle these 40 cards\n${'x'.repeat(20_000)}`
    const { url, marker } = newSessionUrl(long, ['/code'])
    const q = new URL(url).searchParams.get('q')!
    expect(q.length).toBeLessThan(500)
    expect(q).toContain(marker)
    expect(readFileSync(marker, 'utf8')).toBe(long)
    rmSync(marker)
  })

  it('opens and imports sessions by id', () => {
    expect(continueUrl('local_115049c9-20be-4ead-b7b3-6629d684b8f5')).toBe(
      'claude://code/continue?session=local_115049c9-20be-4ead-b7b3-6629d684b8f5',
    )
    expect(importUrl('3a152ee2-c736-40f8-9b54-55b0b58eaf19')).toBe(
      'claude://resume?session=3a152ee2-c736-40f8-9b54-55b0b58eaf19',
    )
  })

  it('names transcript folders the way Claude Code does', () => {
    expect(transcriptFile('/home/someone/projects/my-game', 'abc')).toBe(
      path.join(dir, 'projects', '-home-someone-projects-my-game', 'abc.jsonl'),
    )
  })
})

describe('finding the session a tackle opened', () => {
  const since = Date.parse('2026-10-03T21:00:00.000Z')
  const marker = 'Tackle card RS-961 from the task board: fix "stuck" enemies'

  it('picks the session in the right folder, started after the tackle, whose prompt matches', async () => {
    desktopSession({ local: 'local_old', cli: 'cli-old', cwd: '/code', createdAt: since - 60_000, firstPrompt: marker })
    desktopSession({ local: 'local_other', cli: 'cli-other', cwd: '/elsewhere', createdAt: since + 1000, firstPrompt: marker })
    desktopSession({ local: 'local_wrong', cli: 'cli-wrong', cwd: '/code', createdAt: since + 1000, firstPrompt: 'Something else' })
    expect(await findDesktopSession({ cwd: '/code', since, marker })).toBeUndefined()

    desktopSession({ local: 'local_mine', cli: 'cli-mine', cwd: '/code', createdAt: since + 2000, firstPrompt: `${marker}\n\nrest` })
    expect(await findDesktopSession({ cwd: '/code', since, marker })).toMatchObject({
      desktopId: 'local_mine',
      cliSessionId: 'cli-mine',
    })
    // One already put on a card is skipped.
    expect(await findDesktopSession({ cwd: '/code', since, marker, skip: new Set(['local_mine']) })).toBeUndefined()
  })

  it('waits while the desktop app has no transcript yet (the prompt not sent)', async () => {
    const index = path.join(dir, 'claude-code-sessions', 'a', 'o')
    mkdirSync(index, { recursive: true })
    writeFileSync(
      path.join(index, 'local_new.json'),
      JSON.stringify({ sessionId: 'local_new', cliSessionId: 'cli-new', cwd: '/code', createdAt: since + 500 }),
    )
    expect(await findDesktopSession({ cwd: '/code', since, marker })).toBeUndefined()
  })
})
