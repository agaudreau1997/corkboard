import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TerminalEvent } from '../src/shared/types'
import { notify, notifyArgs, notifyLaunch } from '../src/main/notify'

const WINDOWS = process.platform === 'win32'
const terminal = { id: 'tab-1', title: 'CORK-35 Add notifications', cwd: '/work/corkboard', cardIds: ['CORK-35', 'CORK-36'], kind: 'local' as const }

describe('notifyArgs', () => {
  it('hands the event, the status before it and the title as arguments, and everything as variables', () => {
    const { args, env } = notifyArgs({ event: 'waiting', previous: 'working', terminal })
    expect(args).toEqual(['waiting', 'working', 'CORK-35 Add notifications'])
    expect(env).toEqual({
      CORKBOARD_EVENT: 'waiting',
      CORKBOARD_PREVIOUS: 'working',
      CORKBOARD_TERMINAL: 'tab-1',
      CORKBOARD_TITLE: 'CORK-35 Add notifications',
      CORKBOARD_CWD: '/work/corkboard',
      CORKBOARD_CARDS: 'CORK-35 CORK-36',
      CORKBOARD_KIND: 'local',
    })
  })

  it('says a resumed session is one, apart from its kind', () => {
    const { env } = notifyArgs({ event: 'waiting', previous: 'working', terminal: { ...terminal, kind: 'local-worktree', resumed: true } })
    expect(env.CORKBOARD_KIND).toBe('local-worktree')
    expect(env.CORKBOARD_RESUMED).toBe('1')
  })

  it('adds the exit code on exit, and an empty card list for a plain shell', () => {
    const { env } = notifyArgs({ event: 'exit', previous: 'shell', terminal: { id: 't', title: 'Shell', cwd: '/', kind: 'shell' }, exitCode: 3 })
    expect(env.CORKBOARD_EXIT_CODE).toBe('3')
    expect(env.CORKBOARD_CARDS).toBe('')
    expect(env.CORKBOARD_KIND).toBe('shell')
    expect(env.CORKBOARD_RESUMED).toBeUndefined()
  })
})

describe('notifyLaunch', () => {
  it('runs a program as it is', () => {
    expect(notifyLaunch('/usr/local/bin/ding', ['waiting'])).toEqual({ file: '/usr/local/bin/ding', args: ['waiting'] })
  })

  it.runIf(WINDOWS)('runs a .ps1 through PowerShell and a .cmd or .bat through cmd.exe', () => {
    const ps = notifyLaunch('C:\\tools\\ding.PS1', ['waiting'])
    expect(ps.file.toLowerCase()).toMatch(/powershell\.exe$|pwsh\.exe$/)
    expect(ps.args.slice(-3)).toEqual(['-File', 'C:\\tools\\ding.PS1', 'waiting'])
    expect(notifyLaunch('C:\\tools\\ding.cmd', ['waiting'])).toEqual({ file: 'cmd.exe', args: ['/d', '/c', 'C:\\tools\\ding.cmd', 'waiting'] })
    expect(notifyLaunch('C:\\tools\\ding.bat', [])).toEqual({ file: 'cmd.exe', args: ['/d', '/c', 'C:\\tools\\ding.bat'] })
  })

  it.runIf(!WINDOWS)('leaves a script to its shebang on Unix', () => {
    expect(notifyLaunch('/home/me/ding.ps1', ['x'])).toEqual({ file: '/home/me/ding.ps1', args: ['x'] })
  })
})

// The real thing: a stand-in that records what it was given, run the way a person's would be.
describe('notify', () => {
  let dir: string
  let log: string
  const event: TerminalEvent = { event: 'waiting', previous: 'working', terminal: { ...terminal, title: 'A "quoted" title' } }

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'corkboard-notify-'))
    log = path.join(dir, 'log.txt')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const recorder = `
const { appendFileSync } = require('node:fs')
appendFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), event: process.env.CORKBOARD_EVENT, title: process.env.CORKBOARD_TITLE, cards: process.env.CORKBOARD_CARDS }) + '\\n')
`

  it('runs the program with the event, on this platform', async () => {
    const script = path.join(dir, 'record.cjs')
    writeFileSync(script, recorder)
    let command: string
    if (WINDOWS) {
      command = path.join(dir, 'notify.cmd')
      writeFileSync(command, `@echo off\r\n"${process.execPath}" "${script}" "${log}" %*\r\n`)
    } else {
      command = path.join(dir, 'notify')
      writeFileSync(command, `#!/bin/sh\nexec '${process.execPath}' '${script}' '${log}' "$@"\n`)
      chmodSync(command, 0o755)
    }
    await notify(command, event)
    const [line] = readFileSync(log, 'utf8').trim().split('\n')
    expect(JSON.parse(line)).toEqual({
      argv: ['waiting', 'working', 'A "quoted" title'],
      event: 'waiting',
      title: 'A "quoted" title',
      cards: 'CORK-35 CORK-36',
    })
  })

  it.runIf(WINDOWS)('runs a .ps1 through PowerShell', async () => {
    const psLog = path.join(dir, 'ps.txt')
    const command = path.join(dir, 'notify.ps1')
    writeFileSync(command, `Set-Content -LiteralPath '${psLog}' -Value ("$env:CORKBOARD_EVENT|$env:CORKBOARD_TITLE|" + ($args -join ','))\r\n`)
    await notify(command, event)
    expect(readFileSync(psLog, 'utf8').trim()).toBe('waiting|A "quoted" title|waiting,working,A "quoted" title')
  })

  it('rejects with what the program said when it fails, and when it is missing', async () => {
    const script = path.join(dir, 'fail.cjs')
    writeFileSync(script, "process.stderr.write('no sound device'); process.exit(2)")
    let command: string
    if (WINDOWS) {
      command = path.join(dir, 'fail.cmd')
      writeFileSync(command, `@echo off\r\n"${process.execPath}" "${script}"\r\nexit /b %ERRORLEVEL%\r\n`)
    } else {
      command = path.join(dir, 'fail')
      writeFileSync(command, `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`)
      chmodSync(command, 0o755)
    }
    await expect(notify(command, event)).rejects.toThrow(/no sound device/)
    await expect(notify(path.join(dir, 'missing-program'), event)).rejects.toThrow()
  })
})
