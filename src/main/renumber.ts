// Two machines that had not synced can each make a card under the same id: a new card takes the
// highest number on its board plus one. Both then add `cards/<ID>.md`, and the rebase would take
// that for one card changed on both sides and keep only the side edited last, losing the other.
// So before it rebases, a sync looks for card files added on both sides since they parted. Where
// the two are different cards (their `uid`s differ or, without uids, their `created`), the remote
// one keeps the id and this machine's takes the next free number of its board.
//
// The renumber is written into the local commits themselves, as though the card had had its new
// id from the start. Renaming it in one more commit on top would not do: the rebase replays the
// commit that added the card first, which would still clash, and later local edits of the card
// would be replayed onto the other machine's. The remote side is history others have already, so
// it is never rewritten. Links (`links:`, `after:`) and map positions naming the old id in the
// local commits move with the card: the id was free when the two sides parted, so on this side it
// can only have meant this card. A description that names it is left alone, for a person or a
// session to read: there the old id may mean either card. One more commit then stamps the card's
// `updated:` and records the renumber on it (`renumbered:`), where the app finds it afterwards.
// A file changed but not added on both sides is one card, whatever its uids say (two machines
// giving their cards uids before a sync): the sync's newer-card rule settles it as before.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { cardNumber, parseCard, serializeCard, tryParseCard } from '@shared/cardfile'
import type { Card, Renumber } from '@shared/types'
import { git } from './git'

/** A card file (`<board>/cards/<ID>.md`): its board's path and its id; undefined for any other file. */
export function cardFileOf(file: string): { board: string; id: string } | undefined {
  const m = /^(?:(.+)\/)?cards\/([^/]+)\.md$/.exec(file)
  return m ? { board: m[1] ?? '', id: m[2] } : undefined
}

/** Whether two versions of a card file that both sides added are one card. */
export function sameCard(remote: string, local: string): boolean {
  if (remote === local) return true
  const r = tryParseCard(remote)
  const l = tryParseCard(local)
  // A side saved half-way can't say: the newer-card rule settles it, as for any other card.
  if (!r || !l) return true
  if (r.uid && l.uid) return r.uid === l.uid
  if (r.created && l.created) return r.created === l.created
  return false
}

/** A card file's text under its new id, its images' paths (description and cover) with it. */
export function renamedCardText(text: string, from: string, to: string): string {
  const card = parseCard(text, from)
  const images = new RegExp(`(?<![\\w-])${escapeRegExp(from)}/(?=[\\w-]+\\.\\w+)`, 'g')
  return serializeCard(
    relinked(
      {
        ...card,
        id: to,
        body: card.body.replace(images, `${to}/`),
        cover: card.cover?.startsWith(`${from}/`) ? `${to}${card.cover.slice(from.length)}` : card.cover,
      },
      from,
      to,
    ),
  )
}

/** A card's text with its links and `after:` naming `to` for `from`; undefined when it names neither. */
export function relinkedCardText(text: string, from: string, to: string): string | undefined {
  const card = tryParseCard(text)
  if (!card || (!card.links.includes(from) && !card.after.includes(from))) return undefined
  return serializeCard(relinked(card, from, to))
}

function relinked(card: Card, from: string, to: string): Card {
  const swap = (ids: string[]) => ids.map(id => (id === from ? to : id))
  return { ...card, links: swap(card.links), after: swap(card.after) }
}

/** A map.json's text with the old id's position under the new one; undefined when it has none. */
export function remappedText(text: string, from: string, to: string): string | undefined {
  try {
    const map = JSON.parse(text) as { nodes?: Record<string, unknown> }
    if (!map.nodes?.[from]) return undefined
    const nodes: Record<string, unknown> = {}
    for (const [id, pos] of Object.entries(map.nodes)) nodes[id === from ? to : id] = pos
    return `${JSON.stringify({ ...map, nodes }, null, 2)}\n`
  } catch {
    return undefined
  }
}

/** A renumbered card's text with the renumber recorded on it, and `updated:` stamped. */
export function recordedText(text: string, from: string, at: string): string {
  const card = parseCard(text)
  return serializeCard({ ...card, updated: at, renumbered: [...(card.renumbered ?? []), { from, at }] })
}

/**
 * Renumbers this machine's cards that clash with cards `upstream` added under the same ids, in the
 * local commits it lacks, and moves the branch (and the work tree, which must be clean) to the
 * rewritten commits. Answers the renumbers; none, and nothing changed, when no card clashes.
 */
export async function renumberClashes(root: string, upstream: string): Promise<Renumber[]> {
  const base = (await git(root, ['merge-base', 'HEAD', upstream])).trim()
  const added = async (tip: string) =>
    new Set(
      (await git(root, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', base, tip]))
        .split('\0')
        .filter(f => cardFileOf(f)),
    )
  const theirs = await added(upstream)
  const clashes: (Renumber & { file: string })[] = []
  for (const file of await added('HEAD')) {
    if (!theirs.has(file)) continue
    const local = await show(root, 'HEAD', file)
    if (sameCard(await show(root, upstream, file), local)) continue
    const { board, id } = cardFileOf(file)!
    clashes.push({ file, board, from: id, to: '', uid: tryParseCard(local)?.uid, at: '' })
  }
  if (!clashes.length) return []

  // New numbers free on both sides, counted on every board: a card moved to another keeps its id.
  const taken = new Set<string>()
  for (const tip of ['HEAD', upstream]) {
    for (const f of (await git(root, ['ls-tree', '-r', '-z', '--name-only', tip])).split('\0')) {
      const card = cardFileOf(f)
      if (card) taken.add(card.id)
    }
  }
  for (const clash of clashes) {
    const meta = await show(root, 'HEAD', `${clash.board}/board.json`).catch(() => '')
    const key = (meta && (JSON.parse(meta) as { key?: string }).key) || clash.from.replace(/-\d+$/, '')
    const numbers = [...taken].filter(id => id.startsWith(`${key}-`)).map(cardNumber).filter(Number.isFinite)
    clash.to = `${key}-${Math.max(0, ...numbers) + 1}`
    taken.add(clash.to)
  }

  const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim()
  const index = path.join(gitDir, `corkboard-renumber-${process.pid}.index`)
  const blobFile = path.join(gitDir, `corkboard-renumber-${process.pid}.blob`)
  const inIndex = (args: string[], env: Record<string, string> = {}) =>
    git(root, args, 0, { GIT_INDEX_FILE: index, ...env })
  const blob = async (text: string) => {
    await fs.writeFile(blobFile, text)
    return (await git(root, ['hash-object', '-w', '--no-filters', blobFile])).trim()
  }
  const put = (mode: string, sha: string, file: string) =>
    inIndex(['update-index', '--add', '--cacheinfo', `${mode},${sha},${file}`])

  /** Renames each clashing card in the index, and the links to it; whether anything changed. */
  const renumberIndex = async (): Promise<boolean> => {
    let touched = false
    for (const clash of clashes) {
      const cards = path.posix.dirname(clash.file)
      for (const entry of entries(await inIndex(['ls-files', '-s', '-z', '--', clash.file, `${cards}/${clash.from}/`]))) {
        let { sha } = entry
        let to = `${cards}/${clash.to}/${entry.file.slice(cards.length + clash.from.length + 2)}`
        if (entry.file === clash.file) {
          sha = await blob(renamedCardText(await catBlob(root, sha), clash.from, clash.to))
          to = `${cards}/${clash.to}.md`
        }
        await inIndex(['update-index', '--force-remove', '--', entry.file])
        await put(entry.mode, sha, to)
        touched = true
      }
      const naming = await inIndex(['grep', '--cached', '-l', '-z', '-F', '-e', clash.from, '--', '*.md', '*map.json']).catch(() => '')
      for (const file of naming.split('\0').filter(Boolean)) {
        const entry = entries(await inIndex(['ls-files', '-s', '-z', '--', file]))[0]
        if (!entry) continue
        const text = await catBlob(root, entry.sha)
        const changed = cardFileOf(file)
          ? relinkedCardText(text, clash.from, clash.to)
          : path.posix.basename(file) === 'map.json'
            ? remappedText(text, clash.from, clash.to)
            : undefined
        if (changed === undefined) continue
        await put(entry.mode, await blob(changed), file)
        touched = true
      }
    }
    return touched
  }

  try {
    const commits = (await git(root, ['rev-list', '--reverse', '--first-parent', `${base}..HEAD`])).split('\n').filter(Boolean)
    let parent = base
    let original = base
    for (const commit of commits) {
      await inIndex(['read-tree', commit])
      const touched = await renumberIndex()
      if (touched || parent !== original) {
        const tree = (await inIndex(['write-tree'])).trim()
        const [name, email, date] = (await git(root, ['log', '-1', '--format=%an%x00%ae%x00%aI', commit])).trim().split('\0')
        const message = (await git(root, ['log', '-1', '--format=%B', commit])).replace(/\s+$/, '')
        parent = (
          await git(root, ['commit-tree', tree, '-p', parent, '-m', message], 0, {
            GIT_AUTHOR_NAME: name,
            GIT_AUTHOR_EMAIL: email,
            GIT_AUTHOR_DATE: date,
          })
        ).trim()
      } else {
        parent = commit
      }
      original = commit
    }

    const at = new Date().toISOString()
    await inIndex(['read-tree', parent])
    for (const clash of clashes) {
      clash.at = at
      const file = `${path.posix.dirname(clash.file)}/${clash.to}.md`
      const entry = entries(await inIndex(['ls-files', '-s', '-z', '--', file]))[0]
      if (entry) await put(entry.mode, await blob(recordedText(await catBlob(root, entry.sha), clash.from, at)), file)
    }
    const tree = (await inIndex(['write-tree'])).trim()
    const lines = clashes.map(c => `${c.from} is now ${c.to}: another machine made a card under ${c.from} too.`)
    const subject = clashes.length === 1 ? `Renumber ${clashes[0].from} as ${clashes[0].to}` : `Renumber ${clashes.length} cards`
    const tip = (await git(root, ['commit-tree', tree, '-p', parent, '-m', subject, '-m', lines.join('\n')])).trim()
    // Moves the branch, the index and the files; refuses, changing nothing, over a file written since.
    await git(root, ['reset', '-q', '--keep', tip])
  } finally {
    await fs.rm(index, { force: true })
    await fs.rm(blobFile, { force: true })
  }
  return clashes.map(({ file: _file, ...renumber }) => renumber)
}

function show(root: string, rev: string, file: string): Promise<string> {
  return git(root, ['show', `${rev}:${file}`])
}

function catBlob(root: string, sha: string): Promise<string> {
  return git(root, ['cat-file', 'blob', sha])
}

/** `git ls-files -s -z`, read. */
function entries(out: string): { mode: string; sha: string; file: string }[] {
  return out
    .split('\0')
    .filter(Boolean)
    .map(line => {
      const [info, file] = line.split('\t')
      const [mode, sha] = info.split(' ')
      return { mode, sha, file }
    })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
