// The session's rules for a single-use refresh token: renew before expiry and on a 401, one
// refresh at a time, the new pair saved before it's used, signed out on a refusal and not when
// GitHub is out of reach.

import { describe, expect, it } from 'vitest'
import type { Tokens } from '../src/github/auth'
import { Session, SignedOut, type TokenStore } from '../src/github/session'

function memoryStore(initial?: Tokens) {
  const saved: (Tokens | undefined)[] = []
  let current = initial
  const store: TokenStore = {
    load: async () => current,
    save: async tokens => void saved.push((current = tokens)),
    clear: async () => void saved.push((current = undefined)),
  }
  return { store, saved, current: () => current }
}

const HOUR = 3_600_000

/** A stand-in for github.com: the refresh endpoint, and an API that accepts `valid` tokens. */
function github(options: { valid: Set<string>; refresh?: () => Record<string, unknown> | Error }) {
  let refreshes = 0
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    if (url.includes('/login/oauth/access_token')) {
      refreshes++
      const answer = options.refresh?.() ?? { error: 'bad_refresh_token' }
      if (answer instanceof Error) throw answer
      return new Response(JSON.stringify(answer))
    }
    const auth = new Headers(init.headers).get('Authorization') ?? ''
    return new Response('{}', { status: options.valid.has(auth.replace('Bearer ', '')) ? 200 : 401 })
  }) as typeof fetch
  return { fetchFn, refreshes: () => refreshes }
}

const pair = (n: number) => ({
  access_token: `ghu_${n}`,
  refresh_token: `ghr_${n}`,
  expires_in: 28800,
  refresh_token_expires_in: 15638400,
})

describe('the session', () => {
  it('uses the access token while it has more than a few minutes left', async () => {
    const { store } = memoryStore({ access: 'ghu_1', refresh: 'ghr_1', accessExpires: 2 * HOUR })
    const gh = github({ valid: new Set(['ghu_1']) })
    const session = new Session(store, 'Iv23', gh.fetchFn, () => 0)
    await session.restore()
    expect((await session.api('/user')).status).toBe(200)
    expect(gh.refreshes()).toBe(0)
  })

  it('renews a token about to expire, saving the new pair first', async () => {
    const { store, saved } = memoryStore({ access: 'ghu_1', refresh: 'ghr_1', accessExpires: 60_000 })
    const gh = github({ valid: new Set(['ghu_2']), refresh: () => pair(2) })
    const session = new Session(store, 'Iv23', gh.fetchFn, () => 0)
    await session.restore()
    expect((await session.api('/user')).status).toBe(200)
    expect(saved).toEqual([{ access: 'ghu_2', refresh: 'ghr_2', accessExpires: 28_800_000, refreshExpires: 15_638_400_000 }])
  })

  it('refreshes once for calls made together, since a refresh token is single-use', async () => {
    const { store } = memoryStore({ access: 'ghu_1', refresh: 'ghr_1', accessExpires: 0 })
    let n = 1
    const gh = github({ valid: new Set(['ghu_2']), refresh: () => pair(++n) })
    const session = new Session(store, 'Iv23', gh.fetchFn, () => 0)
    await session.restore()
    const answers = await Promise.all([session.api('/a'), session.api('/b'), session.api('/c')])
    expect(answers.map(a => a.status)).toEqual([200, 200, 200])
    expect(gh.refreshes()).toBe(1)
  })

  it('renews and retries once on a 401', async () => {
    const { store } = memoryStore({ access: 'ghu_1', refresh: 'ghr_1', accessExpires: 2 * HOUR })
    const gh = github({ valid: new Set(['ghu_2']), refresh: () => pair(2) })
    const session = new Session(store, 'Iv23', gh.fetchFn, () => 0)
    await session.restore()
    expect((await session.api('/user')).status).toBe(200)
    expect(gh.refreshes()).toBe(1)
  })

  it('signs out when the refresh is refused, and says why', async () => {
    const memory = memoryStore({ access: 'ghu_1', refresh: 'ghr_1', accessExpires: 0 })
    const gh = github({ valid: new Set() })
    const session = new Session(memory.store, 'Iv23', gh.fetchFn, () => 0)
    const heard: string[] = []
    session.onSignedOut(reason => heard.push(reason))
    await session.restore()
    await expect(session.api('/user')).rejects.toBeInstanceOf(SignedOut)
    expect(memory.current()).toBeUndefined()
    expect(session.signedIn).toBe(false)
    expect(heard).toHaveLength(1)
  })

  it('signs out without asking GitHub once the refresh token has expired', async () => {
    const memory = memoryStore({ access: 'ghu_1', refresh: 'ghr_1', accessExpires: 0, refreshExpires: 10 })
    const gh = github({ valid: new Set(), refresh: () => pair(2) })
    const session = new Session(memory.store, 'Iv23', gh.fetchFn, () => 100)
    await session.restore()
    await expect(session.token()).rejects.toBeInstanceOf(SignedOut)
    expect(gh.refreshes()).toBe(0)
  })

  it('keeps the tokens when GitHub is out of reach', async () => {
    const memory = memoryStore({ access: 'ghu_1', refresh: 'ghr_1', accessExpires: 0 })
    const gh = github({ valid: new Set(), refresh: () => new Error('offline') })
    const session = new Session(memory.store, 'Iv23', gh.fetchFn, () => 0)
    await session.restore()
    await expect(session.token()).rejects.toMatchObject({ kind: 'network' })
    expect(memory.current()?.refresh).toBe('ghr_1')
    expect(session.signedIn).toBe(true)
  })

  it('signs out on a 401 from a token with no expiry (revoked)', async () => {
    const memory = memoryStore({ access: 'ghu_1' })
    const gh = github({ valid: new Set() })
    const session = new Session(memory.store, 'Iv23', gh.fetchFn, () => 0)
    await session.restore()
    await expect(session.api('/user')).rejects.toBeInstanceOf(SignedOut)
    expect(memory.current()).toBeUndefined()
  })
})
