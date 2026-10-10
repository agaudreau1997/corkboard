// How a terminal tab's change reaches the person. The app shows the system's own notification
// when Claude finishes a turn (`desktopNotice` says what it reads; `src/main/index.ts` shows it,
// only while the window is in the background, where the tab's own mark goes unseen). Beyond that
// there is the notification program: one the person configured (app settings), run every time a
// terminal tab changes state, so a sound, a lamp or a push to a phone can say it too. Corkboard runs it with the event as arguments
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

/**
 * The desktop notification for an event, or null for none: only a turn that ended (working, then
 * waiting) asks for one, since that is when the session needs the person back.
 */
export function desktopNotice(e: TerminalEvent): { title: string; body: string } | null {
  if (e.event !== 'waiting' || e.previous !== 'working') return null
  return { title: 'Claude is waiting for you', body: e.terminal.title }
}

/** The arguments (`<event> <previous status> <tab title>`) and variables the program gets. */
export function notifyArgs(e: TerminalEvent): { args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {
    CORKBOARD_EVENT: e.event,
    CORKBOARD_PREVIOUS: e.previous,
    CORKBOARD_TERMINAL: e.terminal.id,
    CORKBOARD_TITLE: e.terminal.title,
    CORKBOARD_CWD: e.terminal.cwd,
    CORKBOARD_CARDS: (e.terminal.cardIds ?? []).join(' '),
    CORKBOARD_KIND: e.terminal.kind,
  }
  if (e.terminal.resumed) env.CORKBOARD_RESUMED = '1'
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
