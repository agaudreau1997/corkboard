// A board's `board.json`: how a change is made to it and how it is said. The desktop's store and
// the companion both write the file through `patchMeta` and `metaText`, so its keys keep their
// order (a change is a small diff, and keys a newer build added survive), and both make a new
// list's id with `newListId`: a slug of its first title, unique among the board's lists, never
// changed by a rename (cards name their list by it). `describeBoardChange` says what changed for
// the commit, in the words of `describeCardChange`: the desktop's auto-commit and the companion's
// writes use it, so a board change reads the same in the log whichever made it.

import { LIST_SORTS, listColorAt, listSort, slugify } from './cardfile'
import type { BoardMeta, ListDef } from './types'

/** `base`, or `base-2`, `base-3`, ... : the first not already a list of the board. */
export function uniqueListId(base: string, lists: Pick<ListDef, 'id'>[]): string {
  let id = base
  for (let n = 2; lists.some(l => l.id === id); n++) id = `${base}-${n}`
  return id
}

/** The id of a new list titled `title`: its slug, unique among the board's lists. */
export function newListId(title: string, lists: Pick<ListDef, 'id'>[]): string {
  return uniqueListId(slugify(title), lists)
}

/** The meta with a patch applied: the key never changes, and an unset or empty value is dropped. */
export function patchMeta<T extends BoardMeta>(meta: T, patch: Partial<BoardMeta>): T {
  const next = { ...meta, ...patch, key: meta.key } as T
  for (const [k, v] of Object.entries(next)) if (v === undefined || v === '') delete (next as Record<string, unknown>)[k]
  return next
}

/** The text of a `board.json`, as the store writes it. */
export function metaText(meta: BoardMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`
}

/** A board.json's text as an object; undefined when it is not one. */
export function parseMetaText(text: string): BoardMeta | undefined {
  try {
    const meta: unknown = JSON.parse(text)
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
    return { ...(meta as BoardMeta), lists: Array.isArray((meta as BoardMeta).lists) ? (meta as BoardMeta).lists : [] }
  } catch {
    return undefined
  }
}

/** What changed between two versions of a board's `board.json`, one commit line each. */
export function describeBoardChange(dir: string, before: BoardMeta | undefined, now: BoardMeta | undefined): string[] {
  if (!before || !now) return [`Edit board ${dir}`]
  const lines: string[] = []
  const on = ` on ${dir}`
  if (before.title !== now.title) lines.push(`Rename board ${dir}: ${now.title}`)
  const was = new Map(before.lists.map((l, i) => [l.id, { list: l, color: listColorAt(before.lists, i) }]))
  const is = new Map(now.lists.map((l, i) => [l.id, { list: l, color: listColorAt(now.lists, i) }]))
  for (const [id, { list, color }] of is) {
    const old = was.get(id)
    if (!old) {
      lines.push(`Add list ${list.title}${on}`)
      continue
    }
    if (old.list.title !== list.title) lines.push(`Rename list ${old.list.title} → ${list.title}${on}`)
    if (!old.list.archived && list.archived) lines.push(`Archive list ${list.title}${on}`)
    if (old.list.archived && !list.archived) lines.push(`Restore list ${list.title}${on}`)
    // The sort the list was given, not the one it shows: a new done list isn't a re-sort.
    const sort = listSort(now, list)
    if ((old.list.sort ?? 'unset') !== (list.sort ?? 'unset')) lines.push(`Sort ${list.title} by ${LIST_SORTS.find(s => s.id === sort)?.label ?? sort}${on}`)
    if (old.color.toLowerCase() !== color.toLowerCase()) lines.push(`Recolour list ${list.title}${on}`)
  }
  for (const [id, { list }] of was) if (!is.has(id)) lines.push(`Remove list ${list.title}${on}`)
  const order = (lists: ListDef[]) => lists.filter(l => was.has(l.id) && is.has(l.id)).map(l => l.id).join()
  if (order(before.lists) !== order(now.lists)) lines.push(`Reorder the lists${on}`)
  for (const role of ['doing', 'done'] as const) {
    const from = before.flow?.[role]
    const to = now.flow?.[role]
    if (from === to) continue
    const title = now.lists.find(l => l.id === to)?.title ?? to
    if (role === 'doing') lines.push(to ? `Tackling moves cards to ${title}${on}` : `Tackling leaves cards where they are${on}`)
    else lines.push(to ? `Finished cards go to ${title}${on}` : `Finished cards stay where they are${on}`)
  }
  return lines.length ? lines : [`Edit board ${dir}`]
}
