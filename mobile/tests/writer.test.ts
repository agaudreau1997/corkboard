// Making a card from the phone: the desktop's card, under the board's next id, one commit with
// the auto-commit's message; the next id when a desktop took that one meanwhile; never twice when
// the answer is lost; and the outbox keeping what can't be sent yet.

import { describe, expect, it } from 'vitest'
import { parseCard } from '@shared/cardfile'
import { RepoCache } from '../src/repo/cache'
import { Outbox } from '../src/repo/outbox'
import { sendDraft, type Draft } from '../src/repo/writer'
import { card, github, MemoryStorage, meta } from './fakes'

const files = () => ({
  'cork/board.json': meta('CORK', 'Cork', [{ id: 'todo', title: 'To do' }]),
  'cork/cards/CORK-1.md': card({ id: 'CORK-1', title: 'First', list: 'todo', pos: 1024 }),
  'cork/cards/CORK-7.md': card({ id: 'CORK-7', title: 'Archived, still counts', list: 'todo', pos: 9000, archived: true }),
})

let n = 0
const draft = (fields: Partial<Draft> = {}): Draft => ({
  key: `k${++n}`,
  repo: 'me/board',
  board: 'cork',
  list: 'todo',
  title: 'Jotted on the bus',
  body: 'With a line of *description*.',
  created: '2026-11-01T21:30:00.000Z',
  uid: `uid-${n}`,
  ...fields,
})

describe('making a card', () => {
  it('writes the next id as the desktop would, in one commit with the auto-commit’s message', async () => {
    const gh = github(files())
    const made = await sendDraft(gh.api, new RepoCache(new MemoryStorage()), draft({ title: 'Café ☕ list' }))
    expect(made.id).toBe('CORK-8')
    expect(gh.writes).toHaveLength(1)
    expect(gh.writes[0]).toMatchObject({ path: 'cork/cards/CORK-8.md', message: 'Add CORK-8: Café ☕ list' })
    const written = parseCard(gh.writes[0].text)
    expect(written).toMatchObject({ id: 'CORK-8', title: 'Café ☕ list', list: 'todo', pos: 2048, uid: made.uid })
    expect(written.body).toBe('With a line of *description*.')
  })

  it('takes the next number when a desktop pushed that id meanwhile', async () => {
    const gh = github(files())
    let once = true
    gh.hooks.beforeWrite = path => {
      if (once && path === 'cork/cards/CORK-8.md') gh.put(path, card({ id: 'CORK-8', title: 'From the desktop', list: 'todo', pos: 3000 }))
      once = false
    }
    const made = await sendDraft(gh.api, new RepoCache(new MemoryStorage()), draft())
    expect(made.id).toBe('CORK-9')
    expect(gh.writes.map(w => w.path)).toEqual(['cork/cards/CORK-9.md'])
  })

  it('doesn’t make it twice when the answer was lost and it’s sent again', async () => {
    const gh = github(files())
    const cache = new RepoCache(new MemoryStorage())
    const d = draft()
    gh.hooks.afterWrite = () => {
      gh.hooks.afterWrite = undefined
      throw new TypeError('Failed to fetch')
    }
    await expect(sendDraft(gh.api, cache, d)).rejects.toThrow(TypeError)
    const again = await sendDraft(gh.api, cache, d)
    expect(again.id).toBe('CORK-8')
    expect(gh.writes).toHaveLength(1)
  })
})

describe('the outbox', () => {
  it('keeps cards written offline, and sends them in order when back', async () => {
    const gh = github(files())
    const cache = new RepoCache(new MemoryStorage())
    const outbox = new Outbox(new MemoryStorage())
    outbox.add(draft({ title: 'One' }))
    outbox.add(draft({ title: 'Two' }))
    gh.goOffline()
    expect(await outbox.send(gh.api, cache)).toBe(0)
    expect(outbox.drafts().map(d => d.title)).toEqual(['One', 'Two'])
    expect(outbox.drafts()[0].error).toBeUndefined()
    gh.goOffline(false)
    expect(await outbox.send(gh.api, cache)).toBe(2)
    expect(outbox.drafts()).toEqual([])
    expect(gh.writes.map(w => w.message)).toEqual(['Add CORK-8: One', 'Add CORK-9: Two'])
  })

  it('notes a refusal on the draft and keeps it, and sends the rest', async () => {
    const gh = github(files())
    const outbox = new Outbox(new MemoryStorage())
    outbox.add(draft({ board: 'gone', title: 'Lost board' }))
    outbox.add(draft({ title: 'Fine' }))
    expect(await outbox.send(gh.api, new RepoCache(new MemoryStorage()))).toBe(1)
    expect(outbox.drafts()).toHaveLength(1)
    expect(outbox.drafts()[0].error).toMatch(/no longer/)
  })

  it('sends once however often it’s asked at the same time', async () => {
    const gh = github(files())
    const cache = new RepoCache(new MemoryStorage())
    const outbox = new Outbox(new MemoryStorage())
    outbox.add(draft())
    await Promise.all([outbox.send(gh.api, cache), outbox.send(gh.api, cache)])
    expect(gh.writes).toHaveLength(1)
  })
})
