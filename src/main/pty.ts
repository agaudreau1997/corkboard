// The embedded terminals: one pseudo-terminal per tab, each a login shell. A tackle runs
// `claude …` inside it and drops back to an interactive shell when Claude exits, so the tab
// stays usable (`claude --resume`, git, the game's tests).

import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import type { PtyInfo, TerminalStatus } from '@shared/types'
import { shellLaunch } from './shell'
import { scanTitles, statusFromTitle } from './termstatus'

type Entry = {
  proc: pty.IPty
  info: PtyInfo
  listeners: ((data: string) => void)[]
  status: TerminalStatus
  /** The end of the last chunk when it cut a title sequence in two. */
  titleCarry: string
}

export type PtyEvents = {
  created: (info: PtyInfo) => void
  data: (id: string, data: string) => void
  exit: (id: string, code: number) => void
  status: (id: string, status: TerminalStatus) => void
}

export class PtyManager {
  private ptys = new Map<string, Entry>()

  constructor(private events: PtyEvents) {}

  /**
   * Opens a terminal in `cwd`. With `command`, the shell runs it first (argv, never re-parsed
   * by a shell, so a prompt needs no quoting) and then stays open.
   */
  create(opts: { title: string; cwd: string; command?: string[]; cardIds?: string[] }): PtyInfo {
    const { file, args, env } = shellLaunch(opts.command)
    const proc = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: opts.cwd, env })
    const info: PtyInfo = { id: randomUUID(), title: opts.title, cwd: opts.cwd, cardIds: opts.cardIds }
    const entry: Entry = { proc, info, listeners: [], status: 'shell', titleCarry: '' }
    this.ptys.set(info.id, entry)
    proc.onData(data => {
      this.events.data(info.id, data)
      for (const listener of entry.listeners) listener(data)
      this.readStatus(entry, data)
    })
    proc.onExit(({ exitCode }) => {
      this.ptys.delete(info.id)
      this.events.exit(info.id, exitCode)
    })
    this.events.created(info)
    return info
  }

  /** Follows the titles the output sets; tells the window when the status changes, not per title. */
  private readStatus(entry: Entry, data: string): void {
    const { titles, carry } = scanTitles(entry.titleCarry, data)
    entry.titleCarry = carry
    if (!titles.length) return
    const status = statusFromTitle(titles[titles.length - 1])
    if (status === entry.status) return
    entry.status = status
    this.events.status(entry.info.id, status)
  }

  /** Extra reader of a terminal's output (a cloud tackle watching for its session URL). */
  listen(id: string, listener: (data: string) => void): () => void {
    const entry = this.ptys.get(id)
    if (!entry) return () => {}
    entry.listeners.push(listener)
    return () => {
      entry.listeners = entry.listeners.filter(l => l !== listener)
    }
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.ptys.get(id)
    if (entry && cols > 0 && rows > 0) entry.proc.resize(cols, rows)
  }

  kill(id: string): void {
    const entry = this.ptys.get(id)
    if (!entry) return
    this.ptys.delete(id)
    entry.proc.kill()
  }

  list(): PtyInfo[] {
    return [...this.ptys.values()].map(e => e.info)
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }
}
