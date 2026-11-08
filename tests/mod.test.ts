// The companion mod: where a build finds its folder, the argv and the environment a session gets
// with it, and the pure half of the mod itself (the environment it reads back).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { modDir } from '../src/main/mod'
import { localCommand, resumeCommand, sessionEnv } from '../src/main/tackle'
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
