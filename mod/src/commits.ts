// The commits of the code repo that name a card, for the pane: the same rule the app's drawer
// uses (`codeCommits` in `src/main/git.ts`), asked of git by the mod itself, so it still answers
// with the app closed. A personal project's commits carry a `Card: <ID>` trailer; a work
// project's name the Jira key instead, and no card id ever reaches that repo.

import type { Commit } from './card'

/** The separators git writes between the fields and the records (%x1f and %x1e). */
const RECORD = '\x1e'
const FIELD = '\x1f'

/**
 * `git log` for the commits whose message holds `needle`, on any branch, newest first. A card id
 * is looked for on a `Card:` trailer line; a Jira key anywhere in the message, as the app does.
 * The pattern is a coarse filter — `namesNeedle` decides — because git has no word boundary every
 * build agrees on.
 */
export function commitArgv(repo: string, needle: string, work: boolean, limit = 20): string[] {
  const pattern = work ? needle : `^Card:.*${needle}`
  return [
    'git',
    '-C',
    repo,
    'log',
    '--all',
    '-i',
    ...(work ? ['-F'] : ['-E']),
    `--grep=${pattern}`,
    `-n${limit}`,
    '--format=%h%x1f%s%x1f%B%x1e',
  ]
}

type Record_ = { sha: string; subject: string; message: string }

/** The records that command printed. */
export function parseCommits(stdout: string): Record_[] {
  return stdout
    .split(RECORD)
    .map(record => record.replace(/^[\r\n]+/, ''))
    .filter(record => record.includes(FIELD))
    .map(record => {
      const [sha, subject, message] = record.split(FIELD)
      return { sha: sha.trim(), subject: (subject ?? '').trim(), message: message ?? '' }
    })
    .filter(record => !!record.sha)
}

/**
 * Those that really name `needle`: between non-alphanumerics, so CORK-10 is not found in
 * CORK-101, and on a `Card:` trailer line unless the project is a work one.
 */
export function commitsNaming(records: Record_[], needle: string, work: boolean): Commit[] {
  const wanted = needle.trim().toUpperCase()
  if (!wanted) return []
  return records
    .filter(record => (work ? namesNeedle(record.message, wanted) : trailerNames(record.message, wanted)))
    .map(record => ({ sha: record.sha, subject: record.subject }))
}

/** The text names it, with no letter or digit against either end. */
export function namesNeedle(text: string, needle: string): boolean {
  let from = 0
  const haystack = text.toUpperCase()
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return false
    const before = haystack[at - 1]
    const after = haystack[at + needle.length]
    if (!alphanumeric(before) && !alphanumeric(after)) return true
    from = at + 1
  }
}

/** A `Card:` trailer line of the message names it (one trailer may name several cards). */
function trailerNames(message: string, id: string): boolean {
  for (const line of message.split('\n')) {
    const trailer = /^\s*Card:\s*(.+?)\s*$/i.exec(line)
    if (!trailer) continue
    if (trailer[1].split(/[,\s]+/).some(named => named.trim().toUpperCase() === id)) return true
  }
  return false
}

function alphanumeric(char: string | undefined): boolean {
  return !!char && /[A-Z0-9]/.test(char)
}
