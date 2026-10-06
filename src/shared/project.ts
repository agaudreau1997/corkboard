// A project's settings: `project.json` at the root of its board repo, so every machine that opens
// the project agrees on them. Today it holds one flag, `work`: the project's code repos are shared
// with teammates and clients, Jira tracks the work, and a card id of the board means nothing there,
// so sessions keep every card id out of the code repo and name the card's Jira key instead. The
// file is the project's, not a board's: a new board of a work project is work from its first
// tackle, where a flag in board.json would have started it personal and let an id through.

import type { ProjectSettings } from './types'

export const PROJECT_FILE = 'project.json'

/** A `project.json`'s text as settings: unknown keys are left out; broken JSON is undefined. */
export function parseProjectSettings(text: string): ProjectSettings | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(raw)) return undefined
  return raw.work === true ? { work: true } : {}
}

/**
 * The text of `project.json` for the settings, or null when there is nothing to write (the file
 * goes). Keys this app does not know are kept from the file's `previous` text, as a card keeps its
 * unknown front matter: a newer build's setting survives a toggle on an older one.
 */
export function projectSettingsText(settings: ProjectSettings, previous?: string): string | null {
  let rest: Record<string, unknown> = {}
  try {
    const parsed: unknown = previous ? JSON.parse(previous) : {}
    if (isObject(parsed)) rest = parsed
  } catch {
    /* a broken file is replaced whole */
  }
  const { work: _work, ...kept } = rest
  const out = { ...(settings.work ? { work: true } : {}), ...kept }
  return Object.keys(out).length ? `${JSON.stringify(out, null, 2)}\n` : null
}

/** Settings from both sides of a sync conflict: this machine's flags, every key either side has. */
export function mergeProjectSettings(remote: string, local: string): string | undefined {
  try {
    const r: unknown = JSON.parse(remote)
    const l: unknown = JSON.parse(local)
    if (!isObject(r) || !isObject(l)) return undefined
    return `${JSON.stringify({ ...r, ...l }, null, 2)}\n`
  } catch {
    return undefined
  }
}

/**
 * Whether a commit message names a Jira key: the key between non-alphanumerics, so ABC-12 is not
 * found in ABC-123 or in XABC-12. Case-insensitive, since a key typed by hand may be lower case.
 */
export function namesKey(message: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i').test(message)
}

/** A Jira key as the card keeps it: trimmed and upper case (`spdi-42` is the same issue as `SPDI-42`). */
export function normalizeKey(value: string | undefined): string | undefined {
  const key = value?.trim().toUpperCase()
  return key || undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
