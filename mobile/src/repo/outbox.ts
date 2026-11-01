// Cards written on the phone wait here until they're sent, so a card jotted down offline isn't
// lost: they're sent in the order they were written, when the app starts, comes back to the front,
// or refreshes. GitHub out of reach stops the run and keeps them all; a refusal (a board gone, a
// permission missing) is noted on that draft, which stays until it's sent or discarded.

import { AuthError } from '../github/auth'
import { SignedOut } from '../github/session'
import type { RepoCache } from './cache'
import { sendDraft, type Draft } from './writer'

type Api = (path: string, init?: RequestInit) => Promise<Response>

const KEY = 'corkboard:outbox'

export class Outbox {
  private sending: Promise<number> | undefined

  constructor(private readonly storage: Storage) {}

  drafts(): Draft[] {
    try {
      return JSON.parse(this.storage.getItem(KEY) ?? '[]') as Draft[]
    } catch {
      return []
    }
  }

  add(draft: Draft): void {
    this.write([...this.drafts(), draft])
  }

  discard(key: string): void {
    this.write(this.drafts().filter(d => d.key !== key))
  }

  /** Sends what waits, once at a time however often it's asked; answers how many went. */
  send(api: Api, cache: RepoCache): Promise<number> {
    this.sending ??= this.run(api, cache).finally(() => (this.sending = undefined))
    return this.sending
  }

  private async run(api: Api, cache: RepoCache): Promise<number> {
    let sent = 0
    for (const draft of this.drafts()) {
      try {
        await sendDraft(api, cache, draft)
        this.discard(draft.key)
        sent++
      } catch (error) {
        if (offline(error) || error instanceof SignedOut) break
        this.write(this.drafts().map(d => (d.key === draft.key ? { ...d, error: (error as Error).message } : d)))
      }
    }
    return sent
  }

  private write(drafts: Draft[]): void {
    this.storage.setItem(KEY, JSON.stringify(drafts))
  }
}

/** A fetch that never got an answer: no connection, rather than GitHub saying no. */
function offline(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof AuthError && error.kind === 'network')
}
