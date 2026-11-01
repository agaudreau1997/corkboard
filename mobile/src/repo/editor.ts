// Changing a card from the phone: a new title or description, another list of its board, archived
// or complete. Each change is one card file written through the Contents API, one commit named the
// way the desktop's auto-commit names it, and it stamps `updated:` (a sync between desktops keeps
// the side changed last). The card goes through `serializeCard`, so its unknown keys and sessions
// survive and a move is a one-line diff.
//
// The file is written against the sha the card was read at. If it changed since (a desktop pushed),
// GitHub refuses, and the card is read again: a move, an archive or a complete is applied again on
// top of it, and so is an edit whose fields nobody else touched. An edit of a title or description
// that was also edited elsewhere is not overwritten without asking: it ends in a Conflict, and
// `overwrite` then writes it over the newer card.

import { between, describeCardChange, serializeCard, sortCards } from '@shared/cardfile'
import type { Card } from '@shared/types'
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
}

/** The card was edited elsewhere in a way this change would overwrite. */
export class Conflict extends Error {
  constructor(readonly theirs: Card) {
    super(`${theirs.id} was edited elsewhere since you opened it.`)
  }
}

type Target = { repo: string; board: string }

const TRIES = 5

/** The card with the change made, stamped, and placed at the end of a new list. */
export function applyChange(card: Card, change: CardChange, boardCards: Card[], now: string): Card {
  const next: Card = { ...card, updated: now }
  if (change.title !== undefined) next.title = change.title.trim() || card.title
  if (change.body !== undefined) next.body = change.body
  if (change.archived !== undefined) next.archived = change.archived || undefined
  if (change.complete !== undefined) next.complete = change.complete || undefined
  if (change.list !== undefined && change.list !== card.list) {
    next.list = change.list
    const inList = sortCards(boardCards.filter(c => c.list === change.list && !c.archived && c.id !== card.id))
    next.pos = between(inList.at(-1)?.pos, undefined)
  }
  return next
}

/** Whether `theirs` changed a field this change sets, since the card was read as `read`. */
function overlaps(read: Card, theirs: Card, change: CardChange): boolean {
  return (change.title !== undefined && theirs.title !== read.title) || (change.body !== undefined && theirs.body !== read.body)
}

/**
 * Writes the change to the card as read (`read`, at blob `sha`). Answers the card as written. With
 * `overwrite`, a title or description edited elsewhere is written over instead of asked about.
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
  let boardCards: Card[] | undefined
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const next = applyChange(base, change, boardCards ?? (await cardsOf(api, cache, at)), now())
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
    boardCards = board.cards
  }
  throw new Error(`${read.id} kept changing while it was being saved: try again.`)
}

async function cardsOf(api: Api, cache: RepoCache, at: Target): Promise<Card[]> {
  const snapshot = cache.snapshot(at.repo) ?? (await refresh(api, cache, at.repo))
  return (await openBoard(undefined, cache, snapshot, at.board))?.cards ?? []
}
