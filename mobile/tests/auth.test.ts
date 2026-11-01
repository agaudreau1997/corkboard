// The device flow and the refresh, against a stand-in for github.com that answers as the real one
// did in the CORK-111 spike.

import { describe, expect, it } from 'vitest'
import { AuthError, pollForTokens, refreshTokens, requestDeviceCode, type DeviceCode } from '../src/github/auth'

type Call = { url: string; form: Record<string, string> }

/** A fetch that records each call and answers the next of `answers` (an Error is thrown). */
function github(...answers: (Record<string, unknown> | Error)[]) {
  const calls: Call[] = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(String(init.body))) })
    const answer = answers.shift()
    if (answer instanceof Error) throw answer
    return new Response(JSON.stringify(answer ?? {}), { status: 200 })
  }) as typeof fetch
  return { fetchFn, calls }
}

const code: DeviceCode = {
  deviceCode: 'dc',
  userCode: 'C0EA-FDC6',
  verificationUri: 'https://github.com/login/device',
  interval: 5,
  expires: 900_000,
}

const tokenAnswer = {
  access_token: 'ghu_a',
  expires_in: 28800,
  refresh_token: 'ghr_a',
  refresh_token_expires_in: 15638400,
  token_type: 'bearer',
  scope: '',
}

describe('the device flow', () => {
  it('asks for a code with the client id alone', async () => {
    const { fetchFn, calls } = github({
      device_code: 'dc',
      user_code: 'C0EA-FDC6',
      verification_uri: 'https://github.com/login/device',
      expires_in: 898,
      interval: 5,
    })
    const got = await requestDeviceCode(fetchFn, 'Iv23', 1000)
    expect(calls).toEqual([{ url: 'https://github.com/login/device/code', form: { client_id: 'Iv23' } }])
    expect(got).toEqual({ ...code, expires: 1000 + 898_000 })
  })

  it('polls through pending and slow_down, then answers the tokens with their expiry times', async () => {
    const { fetchFn, calls } = github({ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, tokenAnswer)
    const slept: number[] = []
    const tokens = await pollForTokens(fetchFn, 'Iv23', code, { sleep: async ms => void slept.push(ms), now: () => 0 })
    expect(slept).toEqual([5000, 5000, 10000])
    expect(calls[0].form).toEqual({
      client_id: 'Iv23',
      device_code: 'dc',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    expect(tokens).toEqual({ access: 'ghu_a', refresh: 'ghr_a', accessExpires: 28_800_000, refreshExpires: 15_638_400_000 })
  })

  it('adds 5 seconds on a slow_down without an interval', async () => {
    const { fetchFn } = github({ error: 'slow_down' }, tokenAnswer)
    const slept: number[] = []
    await pollForTokens(fetchFn, 'Iv23', code, { sleep: async ms => void slept.push(ms), now: () => 0 })
    expect(slept).toEqual([5000, 10000])
  })

  it('keeps polling through a moment offline', async () => {
    const { fetchFn } = github(new Error('offline'), tokenAnswer)
    const tokens = await pollForTokens(fetchFn, 'Iv23', code, { sleep: async () => {}, now: () => 0 })
    expect(tokens.access).toBe('ghu_a')
  })

  it('stops on a declined or expired code', async () => {
    const sleep = async () => {}
    const denied = pollForTokens(github({ error: 'access_denied' }).fetchFn, 'Iv23', code, { sleep })
    await expect(denied).rejects.toMatchObject({ kind: 'denied' })
    const expired = pollForTokens(github({ error: 'expired_token' }).fetchFn, 'Iv23', code, { sleep })
    await expect(expired).rejects.toMatchObject({ kind: 'expired' })
  })

  it('has no expiry times when the app’s token expiry is off', async () => {
    const { fetchFn } = github({ access_token: 'ghu_a', token_type: 'bearer', scope: '' })
    const tokens = await pollForTokens(fetchFn, 'Iv23', code, { sleep: async () => {}, now: () => 0 })
    expect(tokens).toEqual({ access: 'ghu_a', refresh: undefined, accessExpires: undefined, refreshExpires: undefined })
  })
})

describe('the refresh', () => {
  it('sends no client secret, and answers the new pair', async () => {
    const { fetchFn, calls } = github({ ...tokenAnswer, access_token: 'ghu_b', refresh_token: 'ghr_b' })
    const tokens = await refreshTokens(fetchFn, 'Iv23', 'ghr_a', 0)
    expect(calls[0].form).toEqual({ client_id: 'Iv23', grant_type: 'refresh_token', refresh_token: 'ghr_a' })
    expect(tokens.refresh).toBe('ghr_b')
  })

  it('treats a spent refresh token’s misleading answer as refused', async () => {
    const { fetchFn } = github({
      error: 'incorrect_client_credentials',
      error_description: 'The client_id and/or client_secret passed are incorrect.',
    })
    await expect(refreshTokens(fetchFn, 'Iv23', 'ghr_a')).rejects.toMatchObject({ kind: 'refused' })
  })

  it('tells GitHub out of reach from a refusal', async () => {
    const { fetchFn } = github(new Error('offline'))
    const error = await refreshTokens(fetchFn, 'Iv23', 'ghr_a').catch(e => e)
    expect(error).toBeInstanceOf(AuthError)
    expect(error.kind).toBe('network')
  })
})
