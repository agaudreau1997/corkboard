// The Claude desktop app, reached through its `claude://` links (read from the app itself; none
// of this is a documented API):
//   claude://code/new?q=<prompt>&folder=<path>[&folder=<path>]   a new Code session, prompt filled in
//   claude://code/continue?session=local_<id>                       opens one of its sessions
//   claude://resume?session=<cli uuid>                              imports a CLI session
// The app keeps an index of its Code sessions, one `local_<id>.json` per session (with the CLI
// session id, its folder and when it started), which is how a tackle finds the session it opened.

import { execFileSync } from 'node:child_process'
import { existsSync, promises as fs, appendFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The desktop app trims a deep link's prompt to this many characters. */
export const DESKTOP_PROMPT_MAX = 14336
const PROMPT_BUDGET = 14000

/** Whether something handles claude:// links here (on Linux, asks xdg-mime). */
export function desktopAvailable(): boolean {
  if (process.env.CORKBOARD_OPEN_URL_LOG) return true
  if (process.platform !== 'linux') return true
  try {
    return execFileSync('xdg-mime', ['query', 'default', 'x-scheme-handler/claude'], { timeout: 3000 })
      .toString()
      .trim().length > 0
  } catch {
    return false
  }
}

/**
 * The link that opens a new Code session. A prompt longer than the app takes is written to a file
 * and the link asks the session to read it.
 */
export function newSessionUrl(prompt: string, folders: string[]): { url: string; marker: string } {
  let q = prompt
  let marker = prompt.split('\n')[0].slice(0, 80)
  if (prompt.length > PROMPT_BUDGET) {
    const file = path.join(os.tmpdir(), `corkboard-prompt-${Date.now()}.md`)
    writeFileSync(file, prompt)
    q = `Read the task in ${file} and do what it says.`
    marker = file
  }
  const params = new URLSearchParams()
  params.set('q', q)
  for (const folder of folders) params.append('folder', folder)
  return { url: `claude://code/new?${params}`, marker }
}

export function continueUrl(desktopId: string): string {
  return `claude://code/continue?session=${encodeURIComponent(desktopId)}`
}

export function importUrl(cliSessionId: string): string {
  return `claude://resume?session=${encodeURIComponent(cliSessionId)}`
}

/** Opens a claude:// link (the test seam writes it to a file instead). */
export async function openUrl(url: string, open: (url: string) => Promise<void>): Promise<void> {
  const log = process.env.CORKBOARD_OPEN_URL_LOG
  if (log) {
    appendFileSync(log, `${url}\n`)
    return
  }
  await open(url)
}

function configDir(): string {
  if (process.env.CORKBOARD_DESKTOP_SESSIONS_DIR) return process.env.CORKBOARD_DESKTOP_SESSIONS_DIR
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
        : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'))
  return path.join(base, 'Claude', 'claude-code-sessions')
}

function projectsDir(): string {
  return process.env.CORKBOARD_CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects')
}

/** ~/.claude/projects names a folder's transcripts after its path, every other character a dash. */
export function transcriptFile(cwd: string, cliSessionId: string): string {
  return path.join(projectsDir(), cwd.replace(/[^A-Za-z0-9]/g, '-'), `${cliSessionId}.jsonl`)
}

export type DesktopSession = { desktopId: string; cliSessionId: string; cwd: string; createdAt: number }

async function indexFiles(dir: string, depth = 0): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isFile() && /^local_.*\.json$/.test(e.name)) out.push(full)
    else if (e.isDirectory() && depth < 3) out.push(...(await indexFiles(full, depth + 1)))
  }
  return out
}

/**
 * The desktop session a tackle opened: started after `since`, in `cwd`, and whose transcript's
 * first lines carry the prompt's first line (the marker). Undefined until the person has sent the
 * prompt (the transcript only starts then).
 */
export async function findDesktopSession(opts: {
  cwd: string
  since: number
  marker: string
  skip?: Set<string>
}): Promise<DesktopSession | undefined> {
  for (const file of await indexFiles(configDir())) {
    let meta: { sessionId?: string; cliSessionId?: string; cwd?: string; createdAt?: number }
    try {
      meta = JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      continue
    }
    if (!meta.sessionId || !meta.cliSessionId || meta.cwd !== opts.cwd) continue
    if ((meta.createdAt ?? 0) < opts.since - 5000 || opts.skip?.has(meta.sessionId)) continue
    const transcript = transcriptFile(meta.cwd, meta.cliSessionId)
    if (!existsSync(transcript)) continue
    const head = (await fs.readFile(transcript, 'utf8')).slice(0, 200_000)
    if (!head.includes(jsonFragment(opts.marker))) continue
    return { desktopId: meta.sessionId, cliSessionId: meta.cliSessionId, cwd: meta.cwd, createdAt: meta.createdAt ?? 0 }
  }
  return undefined
}

/** The marker as it appears inside a JSON string (quotes and backslashes escaped). */
function jsonFragment(text: string): string {
  return JSON.stringify(text).slice(1, -1)
}
