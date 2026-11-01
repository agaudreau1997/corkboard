// Making a card from the phone: one card file written through GitHub's Contents API, which is
// one commit. The id is the board's next number, taken from the tree just read (every card file's
// name, archived ones included). The file is written without a `sha`, which GitHub only accepts
// for a file that doesn't exist yet: if a desktop pushed that id meanwhile, the board is read again
// and the next number taken. A desktop that made the same id and hasn't pushed yet renumbers its
// own card at its next sync (CORK-105), so the phone's card keeps its id.

import { newCard, nextCardId, serializeCard } from '@shared/cardfile'
import type { Card } from '@shared/types'
import { answerJson } from '../github/answer'
import type { RepoCache } from './cache'
import { openBoard, refresh } from './reader'

type Api = (path: string, init?: RequestInit) => Promise<Response>

/** A card written on the phone and not yet sent. It gets its id when it's sent. */
export type Draft = {
  /** The draft's own id on the phone, until the card has one. */
  key: string
  repo: string
  board: string
  list: string | null
  title: string
  body: string
  created: string
  uid: string
  /** Why the last send failed, when GitHub refused it (not when it was out of reach). */
  error?: string
}

const TRIES = 5

/** Sends a draft: the card as written, under the id it got. */
export async function sendDraft(api: Api, cache: RepoCache, draft: Draft): Promise<Card> {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const snapshot = await refresh(api, cache, draft.repo)
    const board = await openBoard(api, cache, snapshot, draft.board)
    const files = snapshot.boards.find(b => b.path === draft.board)
    if (!board || !files) throw new Error(`The board ${draft.board} is no longer in ${draft.repo}.`)
    // Sent already, and the answer lost on the way back (the connection dropped): don't make it twice.
    const sent = board.cards.find(c => c.uid === draft.uid)
    if (sent) return sent
    const ids = [...files.cards.map(c => c.id), ...board.cards.map(c => c.id)]
    const card = newCard(board.cards, { ...draft, id: nextCardId(board.meta.key, ids) })
    const text = serializeCard(card)
    const path = `${draft.board}/cards/${card.id}.md`
    const response = await api(`/repos/${draft.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Add ${card.id}: ${card.title}`, content: base64(text), branch: snapshot.branch }),
    })
    // 422: the file exists (the id was taken meanwhile). 409: the branch moved under the write.
    if (response.status === 409 || (response.status === 422 && (await clash(response)))) continue
    const answer = await answerJson<{ content: { sha: string } }>(response, `the new card ${card.id}`)
    cache.putBlobs(new Map([[answer.content.sha, text]]))
    return card
  }
  throw new Error(`Every id tried was taken meanwhile: is something else making cards on ${draft.board}?`)
}

async function clash(response: Response): Promise<boolean> {
  const body = (await response.clone().json().catch(() => ({}))) as { message?: string }
  return /sha/i.test(body.message ?? '')
}

/** A card file as the Contents API takes it: its UTF-8 bytes in base64. */
export function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
