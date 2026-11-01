// Changing a card from the phone: a new title or description, another list of its board, archived
// or complete, restored from the archive, its due date, its labels, and the cards it waits on (its
// *Do after*). Each change is one card file written through the Contents API, one commit named the
// way the desktop's auto-commit names it, and it stamps `updated:` (a sync between desktops keeps
// the side changed last). The card goes through `serializeCard`, so its unknown keys and sessions
// survive and a move is a one-line diff.
//
// The file is written against the sha the card was read at. If it changed since (a desktop pushed),
// GitHub refuses, and the card is read again: a move, an archive or a complete is applied again on
// top of it, and so is an edit whose fields nobody else touched. Labels and *Do after* are changed
// as what was added and what was taken away, so they go on top of the others' changes to the same
// keys without losing any (a card waited on that would now make a loop is refused). A title,
// description or due date that was also changed elsewhere is not overwritten without asking: it
// ends in a Conflict, and `overwrite` then writes it over the newer card.

import { between, describeCardChange, serializeCard, sortCards } from '@shared/cardfile'
import { pickDue } from '@shared/due'
import { findCycle } from '@shared/tackleorder'
import type { Card, ListDef } from '@shared/types'
import { answerJson } from '../github/answer'
import type { RepoCache } from './cache'
import { openBoard, refresh } from './reader'
import { base64 } from './writer'

type Api = (path: string, init?: RequestInit) => Promise<Response>

export type CardChange = {
  title?: string
  body?: string
  /** Another list of the board; the card goes at its end. */
  list?: string | null
  archived?: boolean
  complete?: boolean
  /**
   * Out of the archive: to the end of its list if the board still shows that list, else to the
   * ideas (no list). Decided against the board as it is when written.
   */
  restore?: boolean
  /** A day picked for its due date (`2026-11-05`), or null to clear it: see `pickDue`. */
  due?: string | null
  labels?: Edits
  /** The cards of its board it waits on. */
  after?: Edits
}

/** Ids or names added to a card's list of them, and taken out of it. */
export type Edits = { add?: string[]; remove?: string[] }

/** The card was edited elsewhere in a way this change would overwrite. */
export class Conflict extends Error {
  constructor(readonly theirs: Card) {
    super(`${theirs.id} was edited elsewhere since you opened it.`)
  }
}

type Target = { repo: string; board: string }

const TRIES = 5

type BoardNow = { cards: Card[]; lists: ListDef[] }

/** The card with the change made, stamped, and placed at the end of a new list. */
export function applyChange(card: Card, change: CardChange, board: BoardNow, now: string): Card {
  const next: Card = { ...card, updated: now }
  const endOf = (list: string | null) =>
    between(sortCards(board.cards.filter(c => c.list === list && !c.archived && c.id !== card.id)).at(-1)?.pos, undefined)
  if (change.restore && card.archived) {
    const kept = board.lists.some(l => l.id === card.list && !l.archived)
    next.archived = undefined
    next.list = kept ? card.list : null
    next.pos = endOf(next.list)
    return next
  }
  if (change.title !== undefined) next.title = change.title.trim() || card.title
  if (change.body !== undefined) next.body = change.body
  if (change.archived !== undefined) next.archived = change.archived || undefined
  if (change.complete !== undefined) next.complete = change.complete || undefined
  if (change.due !== undefined) next.due = pickDue(card.due, change.due ?? '')
  if (change.labels) next.labels = edited(card.labels, change.labels)
  if (change.after) {
    next.after = edited(card.after, change.after).filter(id => id !== card.id)
    const others = board.cards.filter(c => c.id !== card.id)
    const loop = change.after.add?.length ? findCycle([...others, next]) : undefined
    if (loop) throw new Error(`${card.id} can’t wait on that: the order would loop (${[...loop, loop[0]].join(' → ')}).`)
  }
  if (change.list !== undefined && change.list !== card.list) {
    next.list = change.list
    next.pos = endOf(change.list)
  }
  return next
}

/** The list with the edits made: what's taken out goes, what's added goes at the end, once. */
function edited(list: string[], edits: Edits): string[] {
  const remove = new Set(edits.remove ?? [])
  const out = list.filter(x => !remove.has(x))
  for (const raw of edits.add ?? []) {
    const x = raw.trim()
    if (x && !out.includes(x)) out.push(x)
  }
  return out
}

/** Whether `theirs` changed a field this change sets, since the card was read as `read`. */
function overlaps(read: Card, theirs: Card, change: CardChange): boolean {
  return (
    (change.title !== undefined && theirs.title !== read.title) ||
    (change.body !== undefined && theirs.body !== read.body) ||
    (change.due !== undefined && (theirs.due ?? '') !== (read.due ?? ''))
  )
}

/**
 * Writes the change to the card as read (`read`, at blob `sha`). Answers the card as written. With
 * `overwrite`, a title, description or due date changed elsewhere is written over instead of asked
 * about.
 */
export async function changeCard(
  api: Api,
  cache: RepoCache,
  at: Target,
  read: Card,
  sha: string,
  change: CardChange,
  options: { overwrite?: boolean; now?: () => string } = {},
): Promise<Card> {
  const now = options.now ?? (() => new Date().toISOString())
  let base = read
  let baseSha = sha
  let boardNow: BoardNow | undefined
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const next = applyChange(base, change, boardNow ?? (await boardOf(api, cache, at)), now())
    const path = `${at.board}/cards/${read.id}.md`
    const text = serializeCard(next)
    const response = await api(`/repos/${at.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: describeCardChange(read.id, base, next).join('; '), content: base64(text), sha: baseSha }),
    })
    if (response.status !== 409) {
      const answer = await answerJson<{ content: { sha: string } }>(response, `the change to ${read.id}`)
      cache.putBlobs(new Map([[answer.content.sha, text]]))
      return next
    }
    // Changed since it was read: read it again, and go again on top of it unless that would
    // overwrite someone else's edit without asking.
    const snapshot = await refresh(api, cache, at.repo)
    const board = await openBoard(api, cache, snapshot, at.board)
    const theirs = board?.cards.find(c => c.id === read.id)
    if (!board || !theirs) throw new Error(`${read.id} is no longer on this board.`)
    if (!options.overwrite && overlaps(read, theirs, change)) throw new Conflict(theirs)
    base = theirs
    baseSha = board.shas[read.id]
    boardNow = { cards: board.cards, lists: board.meta.lists }
  }
  throw new Error(`${read.id} kept changing while it was being saved: try again.`)
}

async function boardOf(api: Api, cache: RepoCache, at: Target): Promise<BoardNow> {
  const snapshot = cache.snapshot(at.repo) ?? (await refresh(api, cache, at.repo))
  const board = await openBoard(undefined, cache, snapshot, at.board)
  return { cards: board?.cards ?? [], lists: board?.meta.lists ?? [] }
}
