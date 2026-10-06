import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { legacyArg, shellLaunch } from '../src/main/shell'

describe('legacyArg', () => {
  it('leaves an argument with no quote alone, but doubles a trailing backslash it will quote', () => {
    expect(legacyArg('--add-dir')).toBe('--add-dir')
    expect(legacyArg('C:\\boards\\')).toBe('C:\\boards\\')
    expect(legacyArg('C:\\my boards\\')).toBe('C:\\my boards\\\\')
  })

  it('escapes quotes and the backslashes before them', () => {
    expect(legacyArg('move it to "Done"')).toBe('move it to \\"Done\\"')
    expect(legacyArg('a\\"b')).toBe('a\\\\\\"b')
  })

  it('keeps an empty argument', () => {
    expect(legacyArg('')).toBe('""')
  })
})

// The real thing: each PowerShell on this machine runs the launcher, and the program records the
// argv it got. PowerShell runs a program itself, and a .ps1 like npm's `claude.ps1` in-process,
// which passes its arguments on to node.
describe.runIf(process.platform === 'win32')('shellLaunch on Windows', () => {
  let dir: string
  let echo: string
  let forward: string
  const got = () => path.join(dir, 'argv.json')

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'corkboard-shell-'))
    echo = path.join(dir, 'echo.mjs')
    writeFileSync(
      echo,
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(got())}, JSON.stringify(process.argv.slice(2)))\n`,
    )
    const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`
    forward = path.join(dir, 'forward.ps1')
    writeFileSync(forward, `& ${psQuote(process.execPath)} ${psQuote(echo)} @args\r\n`)
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const args = [
    '--add-dir',
    'C:\\Program Files\\boards\\',
    '-n',
    'MB-202 Give the drill a "sound" of its own',
    'Tackle card MB-202: move it to "Done" (`list: done`) when done.\nPut a `Card: MB-202` trailer on it.',
    'say \\"hi\\" there',
    "it's $env:PATH; & whoami %PATH%",
    '',
    '✳ émoji 漢字',
    'last',
  ]
  const shells = [...new Set(['powershell.exe', shellLaunch(['x']).file])]

  for (const shell of shells) {
    for (const via of ['a program', 'a .ps1'] as const) {
      it(`${path.basename(shell)} hands every argument to ${via} intact`, () => {
        const command = via === 'a program' ? [process.execPath, echo, ...args] : [forward, ...args]
        const launch = shellLaunch(command)
        rmSync(got(), { force: true })
        // As the terminal would run it, but exiting afterwards and without the person's profile.
        const shellArgs = launch.args.map(a => (a === '-NoExit' ? '-NoProfile' : a))
        execFileSync(shell, shellArgs, { env: launch.env, stdio: 'pipe' })
        expect(JSON.parse(readFileSync(got(), 'utf8'))).toEqual(args)
      })
    }
  }
})
