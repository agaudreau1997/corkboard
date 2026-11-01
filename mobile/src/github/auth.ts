// GitHub's device flow and token refresh, for a GitHub App with no client secret: the app asks
// for a code, you approve it at github.com/login/device, and the poll answers a token. The tokens
// expire (8 hours, the refresh token about 6 months) and a refresh answers a new pair; a refresh
// token is good for one use only. `fetch` is passed in: on the phone it's Capacitor's native one
// (github.com's login endpoints send no CORS headers), in the tests a stand-in.

export type Tokens = {
  access: string
  /** Absent when the app's token expiry is off: the access token then lasts until revoked. */
  refresh?: string
  /** Epoch milliseconds. */
  accessExpires?: number
  refreshExpires?: number
}

export type DeviceCode = {
  deviceCode: string
  /** What you type at `verificationUri`, e.g. `C0EA-FDC6`. */
  userCode: string
  verificationUri: string
  /** Seconds between polls. */
  interval: number
  expires: number
}

/**
 * Why a sign-in or refresh failed. `denied`: you declined; `expired`: the code ran out; `refused`:
 * GitHub turned the refresh token down (used, expired or revoked), so you sign in again;
 * `network`: GitHub couldn't be reached, and the tokens are kept for later.
 */
export class AuthError extends Error {
  constructor(
    readonly kind: 'denied' | 'expired' | 'refused' | 'network' | 'failed',
    message: string,
  ) {
    super(message)
  }
}

type Fetch = typeof fetch

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

async function post(fetchFn: Fetch, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    })
  } catch (error) {
    throw new AuthError('network', `GitHub couldn't be reached: ${(error as Error).message}`)
  }
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok && !answer.error) answer.error = `http_${response.status}`
  return answer
}

/** Asks GitHub for a code to approve. */
export async function requestDeviceCode(fetchFn: Fetch, clientId: string, now = Date.now()): Promise<DeviceCode> {
  const answer = await post(fetchFn, 'https://github.com/login/device/code', { client_id: clientId })
  if (answer.error || typeof answer.device_code !== 'string') {
    throw new AuthError('failed', `GitHub gave no code: ${answer.error_description ?? answer.error ?? 'no answer'}`)
  }
  return {
    deviceCode: answer.device_code,
    userCode: String(answer.user_code),
    verificationUri: String(answer.verification_uri ?? 'https://github.com/login/device'),
    interval: Number(answer.interval) || 5,
    expires: now + (Number(answer.expires_in) || 900) * 1000,
  }
}

/** The tokens in a token answer, with their lifetimes turned into times. */
export function tokensFrom(answer: Record<string, unknown>, now: number): Tokens {
  const seconds = (key: string) => (typeof answer[key] === 'number' ? now + (answer[key] as number) * 1000 : undefined)
  return {
    access: String(answer.access_token),
    refresh: typeof answer.refresh_token === 'string' ? answer.refresh_token : undefined,
    accessExpires: seconds('expires_in'),
    refreshExpires: seconds('refresh_token_expires_in'),
  }
}

type PollOptions = {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  signal?: AbortSignal
}

/** Polls until the code is approved, declined or expired; `slow_down` stretches the interval. */
export async function pollForTokens(fetchFn: Fetch, clientId: string, code: DeviceCode, options: PollOptions = {}): Promise<Tokens> {
  const sleep = options.sleep ?? wait
  const now = options.now ?? Date.now
  let interval = code.interval
  for (;;) {
    await sleep(interval * 1000, options.signal)
    if (options.signal?.aborted) throw new AuthError('failed', 'Signing in was cancelled.')
    let answer: Record<string, unknown>
    try {
      answer = await post(fetchFn, 'https://github.com/login/oauth/access_token', {
        client_id: clientId,
        device_code: code.deviceCode,
        grant_type: DEVICE_GRANT,
      })
    } catch (error) {
      // Offline for a moment while you're in the browser: keep polling until the code runs out.
      if (error instanceof AuthError && error.kind === 'network' && now() < code.expires) continue
      throw error
    }
    switch (answer.error) {
      case undefined:
        return tokensFrom(answer, now())
      case 'authorization_pending':
        break
      case 'slow_down':
        interval = Number(answer.interval) || interval + 5
        break
      case 'expired_token':
        throw new AuthError('expired', 'The code expired before it was approved.')
      case 'access_denied':
        throw new AuthError('denied', 'Signing in was declined on GitHub.')
      default:
        throw new AuthError('failed', `GitHub refused the sign-in: ${answer.error_description ?? answer.error}`)
    }
  }
}

/**
 * Trades the refresh token for a new pair. Any answer but tokens is `refused`, whatever its error
 * says: a refresh token used twice is answered `incorrect_client_credentials`.
 */
export async function refreshTokens(fetchFn: Fetch, clientId: string, refresh: string, now = Date.now()): Promise<Tokens> {
  const answer = await post(fetchFn, 'https://github.com/login/oauth/access_token', {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refresh,
  })
  if (answer.error || typeof answer.access_token !== 'string') {
    throw new AuthError('refused', `GitHub refused to renew the sign-in: ${answer.error_description ?? answer.error}`)
  }
  return tokensFrom(answer, now)
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
