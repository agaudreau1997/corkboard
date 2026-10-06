// The notification program: one the person configured (app settings), run every time a terminal
// tab changes state, so a sound, a desktop notification, a lamp or a push can say that Claude
// finished a turn in a tab they are not looking at. Corkboard runs it with the event as arguments
// and as CORKBOARD_* variables rather than through a shell line, so a tab title with quotes reaches
// it intact; the variables carry every value, the arguments the ones a one-line script wants.
//
// On Windows a `.ps1`, `.cmd` or `.bat` cannot be started as a process by itself, so those go
// through PowerShell and cmd.exe; everything else, and everything on Unix, runs as it is.

import { execFile } from 'node:child_process'
import path from 'node:path'
import type { TerminalEvent } from '@shared/types'
import { powershell, WINDOWS } from './shell'

/** A program that runs longer than this is cut off: it should notify and leave. */
const TIMEOUT_MS = 30_000

/** The arguments (`<event> <previous status> <tab title>`) and variables the program gets. */
export function notifyArgs(e: TerminalEvent): { args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {
    CORKBOARD_EVENT: e.event,
    CORKBOARD_PREVIOUS: e.previous,
    CORKBOARD_TERMINAL: e.terminal.id,
    CORKBOARD_TITLE: e.terminal.title,
    CORKBOARD_CWD: e.terminal.cwd,
    CORKBOARD_CARDS: (e.terminal.cardIds ?? []).join(' '),
  }
  if (e.exitCode !== undefined) env.CORKBOARD_EXIT_CODE = String(e.exitCode)
  return { args: [e.event, e.previous, e.terminal.title], env }
}

/** How to start `command` as a process: the file, and the arguments that go before the event's. */
export function notifyLaunch(command: string, args: string[]): { file: string; args: string[] } {
  if (!WINDOWS) return { file: command, args }
  const ext = path.extname(command).toLowerCase()
  if (ext === '.ps1') {
    return { file: powershell(), args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args] }
  }
  if (ext === '.cmd' || ext === '.bat') return { file: 'cmd.exe', args: ['/d', '/c', command, ...args] }
  return { file: command, args }
}

/**
 * Runs the notification program for one event and waits for it to end. Rejects when it could not
 * start or failed, with what it wrote, so the settings can show the person what went wrong.
 */
export function notify(command: string, event: TerminalEvent): Promise<void> {
  const { args, env } = notifyArgs(event)
  const launch = notifyLaunch(command.trim(), args)
  return new Promise((resolve, reject) => {
    execFile(
      launch.file,
      launch.args,
      { env: { ...process.env, ...env }, timeout: TIMEOUT_MS, windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) return resolve()
        const said = String(stderr).trim()
        reject(new Error(said ? `${error.message}\n${said}` : error.message))
      },
    )
  })
}
