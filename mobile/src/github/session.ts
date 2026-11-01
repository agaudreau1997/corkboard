// The signed-in session: the tokens, kept in a store (Android's keystore on the phone), and every
// call to GitHub's API made with a token that is still good. The access token is renewed shortly
// before it expires and once on a 401. Refresh tokens are single-use, so one refresh runs at a
// time and its new pair is saved before it is used: a crash between the two must not leave the
// store holding a spent token. A refused refresh signs you out; GitHub out of reach doesn't.

import { AuthError, refreshTokens, type Tokens } from './auth'

export type TokenStore = {
  load(): Promise<Tokens | undefined>
  save(tokens: Tokens): Promise<void>
  clear(): Promise<void>
}

/** Thrown by a call that needs signing in again; `onSignedOut` hears it too. */
export class SignedOut extends Error {}

/** Renew this long before the access token expires, so a call never starts with a dying one. */
const MARGIN_MS = 5 * 60 * 1000

export class Session {
  private tokens: Tokens | undefined
  private refreshing: Promise<Tokens> | undefined
  private listeners = new Set<(reason: string) => void>()

  constructor(
    private readonly store: TokenStore,
    private readonly clientId: string,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = Date.now,
  ) {}

  /** Reads the stored tokens; answers whether there were any. */
  async restore(): Promise<boolean> {
    this.tokens = await this.store.load()
    return !!this.tokens
  }

  async signIn(tokens: Tokens): Promise<void> {
    await this.store.save(tokens)
    this.tokens = tokens
  }

  /** Forgets the tokens. GitHub can't be told without the client secret: the grant is revoked from GitHub's settings. */
  async signOut(): Promise<void> {
    this.tokens = undefined
    await this.store.clear()
  }

  get signedIn(): boolean {
    return !!this.tokens
  }

  onSignedOut(listener: (reason: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** A good access token, renewed first when it is about to expire. */
  async token(): Promise<string> {
    const tokens = this.tokens
    if (!tokens) throw new SignedOut('Not signed in.')
    if (tokens.accessExpires === undefined || tokens.accessExpires - MARGIN_MS > this.now()) return tokens.access
    return (await this.refresh(tokens)).access
  }

  /** A call to GitHub's REST API (`/user`, ...), signed; one renewal and retry on a 401. */
  async api(path: string, init: RequestInit = {}): Promise<Response> {
    const send = (token: string) =>
      this.fetchFn(`https://api.github.com${path}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...init.headers,
          Authorization: `Bearer ${token}`,
        },
      })
    const token = await this.token()
    const response = await send(token)
    if (response.status !== 401) return response
    const tokens = this.tokens
    if (!tokens) throw new SignedOut('Not signed in.')
    // Another call may have renewed the token meanwhile: retry with that one, else renew.
    const fresh = tokens.access !== token ? tokens : await this.refresh(tokens)
    const again = await send(fresh.access)
    if (again.status === 401) await this.drop('GitHub no longer accepts this sign-in.')
    return again
  }

  private refresh(spent: Tokens): Promise<Tokens> {
    this.refreshing ??= this.renew(spent).finally(() => (this.refreshing = undefined))
    return this.refreshing
  }

  private async renew(spent: Tokens): Promise<Tokens> {
    if (!spent.refresh) return this.drop('The sign-in expired.')
    if (spent.refreshExpires !== undefined && spent.refreshExpires <= this.now()) {
      return this.drop('The sign-in expired after months unused.')
    }
    try {
      const tokens = await refreshTokens(this.fetchFn, this.clientId, spent.refresh, this.now())
      await this.store.save(tokens)
      this.tokens = tokens
      return tokens
    } catch (error) {
      if (error instanceof AuthError && error.kind === 'refused') return this.drop(error.message)
      throw error
    }
  }

  private async drop(reason: string): Promise<never> {
    await this.signOut()
    for (const listener of this.listeners) listener(reason)
    throw new SignedOut(reason)
  }
}
