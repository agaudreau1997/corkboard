// The companion mod: where a build finds its folder, the argv and the environment a session gets
// with it, and the pure half of the mod itself (the environment it reads back).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { modDir } from '../src/main/mod'
import { localCommand, resumeCommand, sessionEnv } from '../src/main/tackle'
import { newCard, serializeCard } from '@shared/cardfile'
import type { Card } from '@shared/types'
import { cardFile, cardFromFile, cardFromTool, fileCommands, type PaneCard, toolJson } from '../mod/src/card'
import { CARD_USAGE, NO_APP, parseCardCommand, showCards } from '../mod/src/command'
import { commitArgv, commitsNaming, namesNeedle, parseCommits } from '../mod/src/commits'
import {
  boardIds,
  guard,
  guardFiles,
  heredocs,
  isGit,
  isInside,
  namesTrailer,
  segments,
} from '../mod/src/guard'
import { bodyLines, paneRows } from '../mod/src/pane'
import {
  CARDS_VAR,
  describeSession,
  envCommands,
  parseEnv,
  SESSION_VARS,
  sessionFromEnv,
} from '../mod/src/session'

const scratch: string[] = []

function temp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'corkboard-mod-'))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the mod folder', () => {
  it('is the repo folder when the app runs from the source, and resources/mod when packaged', () => {
    const root = temp()
    mkdirSync(path.join(root, 'mod'))
    mkdirSync(path.join(root, 'resources', 'mod'), { recursive: true })
    const env = {}
    expect(modDir({ packaged: false, appPath: root, resourcesPath: path.join(root, 'resources'), env })).toBe(
      path.join(root, 'mod'),
    )
    expect(modDir({ packaged: true, appPath: root, resourcesPath: path.join(root, 'resources'), env })).toBe(
      path.join(root, 'resources', 'mod'),
    )
  })

  it('is nothing when the build has no mod, so the session is started without one', () => {
    const root = temp()
    expect(modDir({ packaged: false, appPath: root, resourcesPath: root, env: {} })).toBeUndefined()
  })

  it('takes the test seam, and an empty seam means no mod at all', () => {
    const root = temp()
    mkdirSync(path.join(root, 'mod'))
    const stand = temp()
    expect(modDir({ packaged: false, appPath: root, resourcesPath: root, env: { CORKBOARD_MOD_DIR: stand } })).toBe(stand)
    expect(modDir({ packaged: false, appPath: root, resourcesPath: root, env: { CORKBOARD_MOD_DIR: '' } })).toBeUndefined()
    expect(
      modDir({ packaged: false, appPath: root, resourcesPath: root, env: { CORKBOARD_MOD_DIR: path.join(root, 'gone') } }),
    ).toBeUndefined()
  })
})

describe('the argv of a session with the mod', () => {
  /** Claude Code's grammar: --add-dir and --mcp-config are variadic, --plugin-dir takes one path. */
  function parse(argv: string[]) {
    const out: { dirs: string[]; mcp: string[]; plugins: string[]; prompt?: string; opts: Record<string, string> } = {
      dirs: [],
      mcp: [],
      plugins: [],
      opts: {},
    }
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === '--add-dir') {
        while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) out.dirs.push(argv[++i])
      } else if (arg === '--mcp-config') {
        while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) out.mcp.push(argv[++i])
      } else if (arg === '--plugin-dir') {
        out.plugins.push(argv[++i])
      } else if (['-n', '--session-id', '-w', '--resume'].includes(arg)) {
        out.opts[arg] = argv[++i]
      } else {
        out.prompt = arg
      }
    }
    return out
  }

  it('keeps the prompt last, after the options that take lists', () => {
    for (const worktree of [undefined, 'card-cork-142']) {
      const argv = localCommand({
        claude: 'claude',
        boardRoot: '/b',
        name: 'CORK-142 x',
        sessionId: 'id',
        worktree,
        mcpConfig: '/p/mcp.json',
        pluginDir: '/p/mod',
        prompt: 'Tackle card CORK-142',
      })
      const parsed = parse(argv)
      expect(parsed.prompt).toBe('Tackle card CORK-142')
      expect(parsed.dirs).toEqual(['/b'])
      expect(parsed.mcp).toEqual(['/p/mcp.json'])
      expect(parsed.plugins).toEqual(['/p/mod'])
      expect(parsed.opts['-w']).toBe(worktree)
      expect(argv.indexOf('--plugin-dir')).toBeLessThan(argv.indexOf('-n'))
    }
  })

  it('leaves --plugin-dir out when the build has no mod', () => {
    const argv = localCommand({ claude: 'claude', boardRoot: '/b', name: 'n', sessionId: 'id', prompt: 'p' })
    expect(argv).not.toContain('--plugin-dir')
  })

  it('gives a resumed session the same server and mod', () => {
    const argv = resumeCommand({ claude: 'claude', sessionId: 'uuid', mcpConfig: '/p/mcp.json', pluginDir: '/p/mod' })
    expect(argv).toEqual(['claude', '--mcp-config', '/p/mcp.json', '--plugin-dir', '/p/mod', '--resume', 'uuid'])
    expect(resumeCommand({ claude: 'claude', sessionId: 'uuid' })).toEqual(['claude', '--resume', 'uuid'])
  })
})

describe('the environment a session gets', () => {
  const personal = {
    cards: ['CORK-142', 'CORK-101'],
    boardKey: 'cork-board:cork',
    boardDir: '/boards/cork',
    prefix: 'CORK',
    work: false,
    mod: true,
  }

  it('names the cards, the board, its folder and its card prefix', () => {
    expect(sessionEnv(personal)).toEqual({
      CORKBOARD_CARDS: 'CORK-142,CORK-101',
      CORKBOARD_BOARD: 'cork-board:cork',
      CORKBOARD_BOARD_DIR: '/boards/cork',
      CORKBOARD_CARD_PREFIX: 'CORK',
      CORKBOARD_WORK: '0',
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    })
  })

  it('says so in a work project', () => {
    expect(sessionEnv({ ...personal, work: true }).CORKBOARD_WORK).toBe('1')
  })

  it('turns the plugin API on only for a session that gets the mod', () => {
    expect(sessionEnv({ ...personal, mod: false })).not.toHaveProperty('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS')
  })

  it('round-trips through what the mod reads back', () => {
    const env = sessionEnv({ ...personal, work: true })
    const printed = SESSION_VARS.map(name => env[name]).join('\n')
    const session = sessionFromEnv(parseEnv(printed))
    expect(session).toEqual({
      cards: ['CORK-142', 'CORK-101'],
      board: 'cork-board:cork',
      boardDir: '/boards/cork',
      prefix: 'CORK',
      work: true,
    })
    expect(describeSession(session)).toBe('CORK-142, CORK-101 on cork-board:cork (work mode)')
  })
})

describe('the environment the mod reads', () => {
  it('asks a shell, then cmd.exe, for the variables in order', () => {
    const [unix, windows] = envCommands()
    expect(unix[0]).toBe('sh')
    expect(unix[2]).toContain(`"$${CARDS_VAR}"`)
    expect(windows[0]).toBe('cmd')
    expect(windows[2]).toContain(`echo %${CARDS_VAR}%`)
    for (const argv of envCommands()) expect(SESSION_VARS.every(name => argv[2].includes(name))).toBe(true)
  })

  it('reads a session that Corkboard did not start as holding no cards', () => {
    const session = sessionFromEnv(parseEnv(''))
    expect(session.cards).toEqual([])
    expect(session.work).toBe(false)
    expect(describeSession(session)).toBe('no cards: Corkboard did not start this session')
  })

  it('takes cmd.exe echoing an unset variable back as empty', () => {
    const printed = SESSION_VARS.map(name => `%${name}%`).join('\r\n')
    expect(sessionFromEnv(parseEnv(printed)).cards).toEqual([])
    expect(sessionFromEnv(parseEnv(printed)).board).toBe('')
  })
})

describe('the mod itself', () => {
  const root = path.join(import.meta.dirname, '..', 'mod')

  it('is a plugin folder with a manifest and a hooks module', () => {
    for (const file of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/hooks.ts', 'src/session.ts']) {
      expect({ file, there: existsSync(path.join(root, file)) }).toEqual({ file, there: true })
    }
    const manifest = JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
    const hooks = JSON.parse(readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'))
    expect(manifest.name).toBe('corkboard-mod')
    expect(hooks.modules).toEqual(['./hooks.ts'])
  })

  // Claude Code refuses to load a module that binds $ to a name, passes it on, or reads a method
  // off it without calling it: `claude plugin validate mod` says so, and CI has no Claude Code,
  // so the code (comments taken out) is read for the shape here too.
  it('reaches the engine only as $.noun.method(...)', () => {
    const code = readFileSync(path.join(root, 'hooks', 'hooks.ts'), 'utf8')
      .split('\n')
      .filter(line => !line.trimStart().startsWith('//'))
      .join('\n')
    // Either the hook's own parameter ($, or $:), a template's ${…}, or a call: a noun, a
    // method and a bracket.
    const mentions = code.match(/\$[\w.]*[({,:]?/g) ?? []
    expect(mentions.length).toBeGreaterThan(0)
    for (const mention of mentions) expect(mention).toMatch(/^\$([,:{]|\.[a-z]+\.[a-zA-Z]+\()$/)
  })

  // Claude Code's own check: it reads the manifest and the module and reports what the module
  // hooks and calls. Skipped where there is no Claude Code, as on CI.
  it('passes claude plugin validate', () => {
    const claude = process.env.CORKBOARD_CLAUDE_BIN || 'claude'
    try {
      const out = execFileSync(claude, ['plugin', 'validate', `"${root}"`], {
        encoding: 'utf8',
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(out).toContain('Validation passed')
      expect(out).toContain('session.start')
    } catch (error) {
      const failed = error as { status?: number; stdout?: string; stderr?: string }
      const said = `${failed.stdout ?? ''}${failed.stderr ?? ''}`
      // No Claude Code here: a shell that found nothing to run says so and exits 1 or 127.
      if (/not recognized|not found|command not found/i.test(said)) return
      throw new Error(`claude plugin validate said: ${said}`)
    }
  })
})

describe('the cards the pane shows', () => {
  const answer = (card: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(card) }] })

  it('reads what a board tool answered out of its MCP result', () => {
    const card = { id: 'CORK-101', title: 'A pane', listTitle: 'Doing', description: 'Beside the chat.', links: ['CORK-142'] }
    expect(cardFromTool(toolJson(answer(card))!)).toEqual({
      id: 'CORK-101',
      title: 'A pane',
      listTitle: 'Doing',
      description: 'Beside the chat.',
      links: ['CORK-142'],
      commits: [],
      from: 'app',
    })
  })

  it('takes a refusal, a missing text block and broken JSON as no answer at all', () => {
    expect(toolJson({ isError: true, content: [{ type: 'text', text: 'No card CORK-999.' }] })).toBeUndefined()
    expect(toolJson({ content: [] })).toBeUndefined()
    expect(toolJson({ content: [{ type: 'text', text: '{' }] })).toBeUndefined()
    expect(toolJson(undefined)).toBeUndefined()
  })

  it('finds the card file under the board folder, in either kind of path', () => {
    expect(cardFile('/boards/cork', 'CORK-101')).toBe('/boards/cork/cards/CORK-101.md')
    expect(cardFile('/boards/cork/', 'CORK-101')).toBe('/boards/cork/cards/CORK-101.md')
    expect(cardFile('D:\\boards\\cork', 'CORK-101')).toBe('D:\\boards\\cork\\cards\\CORK-101.md')
  })

  it('prints the card file with a shell, then cmd.exe, the path an argument in both', () => {
    const [unix, windows] = fileCommands('D:\boards\my cork\cards\CORK-101.md')
    expect(unix.slice(0, 3)).toEqual(['sh', '-c', 'cat -- "$1"'])
    expect(unix.at(-1)).toBe('D:\boards\my cork\cards\CORK-101.md')
    expect(windows.slice(0, 3)).toEqual(['cmd', '/c', 'type'])
    expect(windows.at(-1)).toBe('D:\boards\my cork\cards\CORK-101.md')
  })

  it('reads a card file the app wrote, for a session whose Corkboard is closed', () => {
    const card: Card = {
      ...newCard([], { id: 'CORK-101', uid: 'u1', created: '2026-11-01T00:00:00.000Z', title: 'A pane: read-only', list: 'doing' }),
      links: ['CORK-142'],
      jira: 'SPDI-42',
      body: 'Beside the chat.\n\nA second paragraph.\n',
    }
    const read = cardFromFile(serializeCard(card), 'CORK-101')
    expect(read).toMatchObject({
      id: 'CORK-101',
      title: 'A pane: read-only',
      listTitle: 'doing',
      links: ['CORK-142'],
      jira: 'SPDI-42',
      from: 'file',
    })
    expect(read.description.startsWith('Beside the chat.')).toBe(true)
  })

  it('reads a card with no list and no links as an idea with neither', () => {
    const card = newCard([], { id: 'CORK-9', uid: 'u2', created: '2026-11-01T00:00:00.000Z', title: 'An idea', list: null })
    const read = cardFromFile(serializeCard(card), 'CORK-9')
    expect({ list: read.listTitle, links: read.links, jira: read.jira }).toEqual({ list: '', links: [], jira: undefined })
  })
})

describe("a card's commits", () => {
  const log = (records: { sha: string; subject: string; message: string }[]) =>
    records.map(r => `${r.sha}\x1f${r.subject}\x1f${r.message}\x1e`).join('\n')

  it('asks git for the trailer in a personal project and for the key in a work one', () => {
    const personal = commitArgv('/repo', 'CORK-101', false)
    expect(personal.slice(0, 6)).toEqual(['git', '-C', '/repo', 'log', '--all', '-i'])
    expect(personal).toContain('--grep=^Card:.*CORK-101')
    expect(personal).toContain('-E')
    const work = commitArgv('/repo', 'SPDI-42', true)
    expect(work).toContain('--grep=SPDI-42')
    expect(work).toContain('-F')
    expect(work).not.toContain('--grep=^Card:.*SPDI-42')
  })

  it('keeps the commits whose trailer names the card, one trailer naming several included', () => {
    const out = log([
      { sha: 'aaa1111', subject: 'Draw the pane', message: 'Draw the pane\n\nCard: CORK-101\n' },
      { sha: 'bbb2222', subject: 'Both at once', message: 'Both at once\n\nCard: CORK-101, CORK-142\n' },
      { sha: 'ccc3333', subject: 'Merge branch', message: 'Merge branch CORK-101-pane\n' },
    ])
    expect(commitsNaming(parseCommits(out), 'CORK-101', false)).toEqual([
      { sha: 'aaa1111', subject: 'Draw the pane' },
      { sha: 'bbb2222', subject: 'Both at once' },
    ])
  })

  it('does not find CORK-10 in CORK-101', () => {
    const out = log([{ sha: 'aaa1111', subject: 'The pane', message: 'The pane\n\nCard: CORK-101\n' }])
    expect(commitsNaming(parseCommits(out), 'CORK-10', false)).toEqual([])
  })

  it('names the key anywhere in a work project, and only between non-alphanumerics', () => {
    const out = log([
      { sha: 'aaa1111', subject: 'SPDI-42 fix the form', message: 'SPDI-42 fix the form\n' },
      { sha: 'bbb2222', subject: 'Part of SPDI-420', message: 'Part of SPDI-420\n' },
    ])
    expect(commitsNaming(parseCommits(out), 'SPDI-42', true)).toEqual([{ sha: 'aaa1111', subject: 'SPDI-42 fix the form' }])
    expect(namesNeedle('see SPDI-42.', 'SPDI-42')).toBe(true)
    expect(namesNeedle('SPDI-421', 'SPDI-42')).toBe(false)
  })

  it('reads nothing out of an empty log', () => {
    expect(parseCommits('')).toEqual([])
    expect(commitsNaming([], 'CORK-101', false)).toEqual([])
  })
})

describe('the pane', () => {
  const card = (over: Partial<PaneCard> = {}): PaneCard => ({
    id: 'CORK-101',
    title: 'A card pane for the sessions Corkboard starts',
    listTitle: 'Doing',
    description: 'A pane beside the chat showing the cards the session was started for.\n\nRead-only.',
    links: ['CORK-142'],
    commits: [],
    from: 'app',
    ...over,
  })

  it('names the card, its list and its title, then its description and its links', () => {
    const rows = paneRows([card({ commits: [{ sha: '7c47485', subject: 'Give the sessions a mod' }] })], {
      columns: 90,
      maxRows: 8,
      work: false,
    })
    expect(rows[0]).toMatchObject({ tone: 'head' })
    expect(rows[0].text).toBe('▣ CORK-101 · Doing · A card pane for the sessions Corkboard starts')
    expect(rows[1]).toMatchObject({ tone: 'body' })
    expect(rows[1].text.startsWith('A pane beside the chat')).toBe(true)
    expect(rows.at(-1)).toMatchObject({ tone: 'dim', text: 'links CORK-142 · 7c47485 Give the sessions a mod' })
  })

  it('says when it is reading the card file, because Corkboard is closed', () => {
    const rows = paneRows([card({ from: 'file', links: [] })], { columns: 90, maxRows: 8, work: false })
    expect(rows.at(-1)?.text).toBe('from the card file (Corkboard is closed)')
  })

  it('names the Jira key beside the id in a work project', () => {
    const rows = paneRows([card({ jira: 'SPDI-42' })], { columns: 90, maxRows: 8, work: true })
    expect(rows[0].text.startsWith('▣ CORK-101 (SPDI-42) · Doing')).toBe(true)
    expect(rows.at(-1)?.text).toContain('SPDI-42')
  })

  it('shows every card of a session of several', () => {
    const rows = paneRows([card(), card({ id: 'CORK-142', title: 'The mod' })], { columns: 90, maxRows: 20, work: false })
    expect(rows.filter(r => r.tone === 'head').map(r => r.text.split(' · ')[0])).toEqual(['▣ CORK-101', '▣ CORK-142'])
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length)
  })

  it('keeps inside the rows the band allows, the card at hand last', () => {
    const rows = paneRows([card(), card({ id: 'CORK-142' })], { columns: 90, maxRows: 3, work: false })
    expect(rows.length).toBe(3)
    expect(rows.at(-1)?.tone).toBe('dim')
  })

  it('folds the description to the width and ends it in an ellipsis', () => {
    const lines = bodyLines('one two three four five six seven eight nine ten', 20, 2)
    expect(lines.length).toBe(2)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20)
    expect(lines[1].endsWith('…')).toBe(true)
    expect(bodyLines('', 20)).toEqual([])
  })

  it('clips a long head row to the width', () => {
    const rows = paneRows([card({ title: 'x'.repeat(200) })], { columns: 40, maxRows: 8, work: false })
    expect(rows[0].text.length).toBeLessThanOrEqual(38)
    expect(rows[0].text.endsWith('…')).toBe(true)
  })
})

describe('the /card command', () => {
  it('is read under the plugin namespace Claude Code gives it, and bare', () => {
    expect(parseCardCommand('/corkboard-mod:card')).toEqual({ kind: 'show' })
    expect(parseCardCommand('/card')).toEqual({ kind: 'show' })
    expect(parseCardCommand('  /corkboard-mod:card  ')).toEqual({ kind: 'show' })
  })

  it('leaves an ordinary prompt alone', () => {
    for (const prompt of ['card done', 'Move the card to done', '/cards done', '/carding', 'tell me about /card', 42, undefined]) {
      expect(parseCardCommand(prompt)).toBeUndefined()
    }
  })

  it('reads done, note and new', () => {
    expect(parseCardCommand('/card done')).toEqual({ kind: 'done' })
    expect(parseCardCommand('/card note Checked on Windows too.')).toEqual({ kind: 'note', text: 'Checked on Windows too.' })
    expect(parseCardCommand('/card new Rename the tabs')).toEqual({ kind: 'new', title: 'Rename the tabs' })
  })

  it('takes a list for a new card, before or after the title, and leaves it out of the title', () => {
    expect(parseCardCommand('/card new Rename the tabs --list todo')).toEqual({ kind: 'new', title: 'Rename the tabs', list: 'todo' })
    expect(parseCardCommand('/card new --list=todo Rename the tabs')).toEqual({ kind: 'new', title: 'Rename the tabs', list: 'todo' })
  })

  it('says what it takes when it was given nothing to work with', () => {
    expect(parseCardCommand('/card note')).toMatchObject({ kind: 'unknown' })
    expect(parseCardCommand('/card new')).toMatchObject({ kind: 'unknown' })
    expect(parseCardCommand('/card finish')).toMatchObject({ kind: 'unknown', said: 'card does not know "finish".' })
    expect(CARD_USAGE).toContain('card new <title>')
  })

  it('answers with one line, whatever the session holds', () => {
    const card = (id: string, over = {}): PaneCard => ({
      id,
      title: 'A card pane',
      listTitle: 'Doing',
      description: 'Beside the chat.',
      links: [],
      commits: [],
      from: 'app',
      ...over,
    })
    expect(showCards([], false)).toBe('corkboard: this session holds no cards.')
    expect(showCards([card('CORK-101')], false)).toBe('corkboard: CORK-101 · Doing · A card pane')
    const both = showCards([card('CORK-101'), card('CORK-142')], false)
    expect(both).toBe('corkboard: CORK-101 · Doing · A card pane | CORK-142 · Doing · A card pane')
    expect(both.includes('\n')).toBe(false)
    expect(showCards([card('CORK-101', { jira: 'SPDI-42' })], true)).toContain('CORK-101 (SPDI-42)')
  })

  it('has a line for a command that would write with the app closed', () => {
    expect(NO_APP).toContain('Corkboard is closed')
  })
})

describe('the card-id rule on a session\'s commands', () => {
  const personal = { cards: ['CORK-101'], prefix: 'CORK', work: false, repo: '/code' }
  const work = { cards: ['SPDI-1'], prefix: 'SPDI', work: true, keys: ['SPDI-42'], repo: '/code' }
  const denied = (verdict: { deny: string } | undefined) => verdict?.deny ?? ''

  describe('a personal project: every commit names its card', () => {
    it('refuses a commit with no trailer, naming the trailer to add', () => {
      const verdict = guard('git commit -m "Draw the pane"', personal)
      expect(denied(verdict)).toContain('Card: CORK-101')
    })

    it('lets a commit that carries the trailer through, in its own -m or a later one', () => {
      expect(guard('git commit -m "Draw the pane\n\nCard: CORK-101"', personal)).toBeUndefined()
      expect(guard('git commit -m "Draw the pane" -m "Card: CORK-101"', personal)).toBeUndefined()
      expect(guard('git commit -m "Draw it" -m "Card: CORK-101, CORK-142"', personal)).toBeUndefined()
    })

    it('reads a message out of a heredoc and out of a file', () => {
      const heredoc = "git commit -F - <<'MSG'\nDraw the pane\n\nCard: CORK-101\nMSG"
      expect(guard(heredoc, personal)).toBeUndefined()
      const missing = "git commit -F - <<'MSG'\nDraw the pane\nMSG"
      expect(denied(guard(missing, personal))).toContain('Card: CORK-101')
      expect(guard('git commit -F msg.txt', personal, { 'msg.txt': 'Draw it\n\nCard: CORK-101\n' })).toBeUndefined()
      expect(denied(guard('git commit -F msg.txt', personal, { 'msg.txt': 'Draw it\n' }))).toContain('Card: CORK-101')
    })

    it('leaves a message it cannot read alone: a file it could not open, or a command', () => {
      expect(guard('git commit -F msg.txt', personal)).toBeUndefined()
      expect(guard('git commit -m "$(cat msg.txt)"', personal)).toBeUndefined()
    })

    it('leaves the commits git writes the message for alone', () => {
      for (const command of [
        'git merge --no-ff topic',
        'git revert --no-edit HEAD',
        'git rebase --continue',
        'git cherry-pick abc1234',
        'git commit --amend --no-edit',
        'git commit',
      ]) {
        expect({ command, verdict: guard(command, personal) }).toEqual({ command, verdict: undefined })
      }
    })

    it('judges an --amend that writes a new message', () => {
      expect(denied(guard('git commit --amend -m "Draw the pane"', personal))).toContain('Card: CORK-101')
      expect(guard('git commit --amend -m "Draw it\n\nCard: CORK-101"', personal)).toBeUndefined()
    })

    it('finds the commit in a line of several commands, and ignores the rest', () => {
      expect(guard('git add -A && echo done', personal)).toBeUndefined()
      expect(denied(guard('git add -A && git commit -m "Draw it" && git push', personal))).toContain('Card: CORK-101')
    })

    it('leaves another repo alone', () => {
      expect(guard('git -C /elsewhere commit -m "Draw it"', personal)).toBeUndefined()
      expect(guard('git -C ../other commit -m "Draw it"', personal)).toBeUndefined()
      expect(denied(guard('git -C /code/sub commit -m "Draw it"', personal))).toContain('Card: CORK-101')
      expect(denied(guard('git -C . commit -m "Draw it"', personal))).toContain('Card: CORK-101')
    })

    it('says nothing about a session that holds no cards', () => {
      expect(guard('git commit -m "Draw it"', { ...personal, cards: [] })).toBeUndefined()
    })
  })

  describe('a work project: no card id reaches the repo', () => {
    it('refuses a card id in a commit message, naming the Jira key instead', () => {
      const verdict = guard('git commit -m "SPDI-7 and SPDI-1 fix the form"', work)
      expect(denied(verdict)).toContain('must not reach this repo')
      expect(denied(verdict)).toContain('SPDI-42')
    })

    it('refuses it in a branch name, however the branch is made', () => {
      for (const command of [
        'git branch SPDI-7-fix',
        'git checkout -b SPDI-7-fix',
        'git switch -c SPDI-7-fix',
        'git branch -m SPDI-7-fix',
        'git tag SPDI-7',
      ]) {
        expect({ command, denied: denied(guard(command, work)).includes('SPDI-7') }).toEqual({ command, denied: true })
      }
    })

    it("refuses it in a pull request's title or body, file and heredoc included", () => {
      expect(denied(guard('gh pr create --title "SPDI-7 the form" --body "done"', work))).toContain('SPDI-7')
      expect(denied(guard('gh pr edit --body "closes SPDI-7"', work))).toContain('SPDI-7')
      expect(denied(guard("gh pr create --title x --body-file b.md", work, { 'b.md': 'SPDI-7\n' }))).toContain('SPDI-7')
      expect(denied(guard("gh pr create --title x --body \"$(cat <<'B'\nSPDI-7\nB\n)\"", work))).toContain('SPDI-7')
    })

    it('says nothing about an id-like string that is no card of the board', () => {
      expect(guard('git commit -m "ABCD-7 and SPDI7 and SPDI-x"', work)).toBeUndefined()
      expect(guard('git checkout -b ABCD-7-fix', work)).toBeUndefined()
    })

    it('does not find SPDI-1 inside SPDI-100', () => {
      expect(guard('git commit -m "about SPDI-100"', { ...work, prefix: 'SPDI' })).toMatchObject({ deny: expect.stringContaining('SPDI-100') })
      expect(guard('git commit -m "nothing of the board"', work)).toBeUndefined()
    })

    it('leaves the commands that only read a card alone, card file and log included', () => {
      for (const command of [
        'cat ../board/cork/cards/SPDI-7.md',
        'git log --grep=SPDI-7',
        'grep -r SPDI-7 notes/',
        'echo SPDI-7',
      ]) {
        expect({ command, verdict: guard(command, work) }).toEqual({ command, verdict: undefined })
      }
    })

    it('asks for no trailer in a work project', () => {
      expect(guard('git commit -m "Fix the login form"', work)).toBeUndefined()
    })

    it('names the rule when it knows no Jira key yet', () => {
      expect(denied(guard('git commit -m "SPDI-7 fix"', { ...work, keys: [] }))).toContain('Jira key')
    })
  })

  describe('reading a shell line', () => {
    it('splits on the operators and keeps quoted words whole', () => {
      expect(segments('git add -A && git commit -m "two words"')).toEqual([
        ['git', 'add', '-A'],
        ['git', 'commit', '-m', 'two words'],
      ])
      expect(segments('echo hi | wc -l; ls')).toEqual([['echo', 'hi'], ['wc', '-l'], ['ls']])
    })

    it('takes a heredoc apart from the words', () => {
      const command = "git commit -F - <<'MSG'\nDraw it\n\nCard: CORK-101\nMSG\ngit push"
      expect(segments(command)).toEqual([['git', 'commit', '-F', '-'], ['git', 'push']])
      expect(heredocs(command)).toEqual(['Draw it\n\nCard: CORK-101'])
    })

    it('knows a git verb behind git\'s own options, and the ids of a board', () => {
      expect(isGit(['git', '-C', 'dir', 'commit'], 'commit')).toBe(true)
      expect(isGit(['git', 'commit'], 'push')).toBe(false)
      expect(isGit(['hub', 'commit'], 'commit')).toBe(false)
      expect(boardIds('CORK-1 and cork-2, CORK-30x, CORK-4.', 'CORK')).toEqual(['CORK-1', 'CORK-2', 'CORK-4'])
      expect(namesTrailer('Draw it\n\nCard: CORK-101\n', 'cork-101')).toBe(true)
      expect(namesTrailer('Draw it\n\nCards: CORK-101\n', 'CORK-101')).toBe(false)
    })

    it('compares paths across separators and cases', () => {
      expect(isInside('D:\\code\\sub', 'd:/code')).toBe(true)
      expect(isInside('/code', '/code/')).toBe(true)
      expect(isInside('/codex', '/code')).toBe(false)
    })

    it('names the files it needs read', () => {
      expect(guardFiles('git commit -F msg.txt && gh pr create --body-file b.md')).toEqual(['msg.txt', 'b.md'])
      expect(guardFiles('git commit -F -')).toEqual([])
    })
  })
})
