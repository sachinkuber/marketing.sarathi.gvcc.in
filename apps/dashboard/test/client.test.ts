import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ApiError, api, safeNext, setCsrfToken, signInAddress } from '../src/api/client'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

let calls: Call[]
let assign: ReturnType<typeof vi.fn>
let replies: Array<{ status: number; body: unknown }>

function location(pathname: string, search = '') {
  vi.stubGlobal('window', { location: { pathname, search, assign } })
}

beforeEach(() => {
  calls = []
  replies = []
  assign = vi.fn()
  setCsrfToken(null)
  location('/b/b1/inbox', '?filter=overdue')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body })
      const next = replies.shift() ?? { status: 200, body: {} }
      return new Response(JSON.stringify(next.body), { status: next.status })
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

const session = {
  user: { id: 'u1', email: 'a@example.test', name: 'A' },
  twoFactorEnabled: true,
  needsSecondFactor: true,
  enrolmentRequired: false,
  platformOwner: false,
  memberships: [{ brandId: 'b1', role: 'approver' }],
  csrfToken: 'tok-123',
}
const ok = z.strictObject({ ok: z.boolean() })

describe('the API client', () => {
  it('sends the request token on a write, fetched once from the session, and none on a read', async () => {
    replies.push({ status: 200, body: { ok: true } })
    await api(ok, 'GET', '/things')
    expect(calls[0]?.headers['x-csrf-token']).toBeUndefined()
    expect(calls[0]?.url).toBe('/api/v1/things')

    replies.push({ status: 200, body: session }, { status: 201, body: { ok: true } })
    await api(ok, 'POST', '/things', { a: 1 })
    expect(calls[1]?.url).toBe('/api/v1/session')
    expect(calls[2]?.method).toBe('POST')
    expect(calls[2]?.headers['x-csrf-token']).toBe('tok-123')
    expect(calls[2]?.headers['content-type']).toBe('application/json')
    expect(calls[2]?.body).toBe('{"a":1}')

    replies.push({ status: 200, body: { ok: true } })
    await api(ok, 'DELETE', '/things/1')
    expect(calls.length).toBe(4)
    expect(calls[3]?.headers['x-csrf-token']).toBe('tok-123')
  })

  it('asks for a fresh token once when the cached one is refused', async () => {
    setCsrfToken('old')
    replies.push(
      { status: 403, body: { error: { code: 'bad_csrf_token', message: 'no' } } },
      { status: 200, body: session },
      { status: 200, body: { ok: true } },
    )
    await expect(api(ok, 'POST', '/things', {})).resolves.toEqual({ ok: true })
    expect(calls[2]?.headers['x-csrf-token']).toBe('tok-123')
  })

  it('throws bad_reply when the reply does not fit its schema', async () => {
    replies.push({ status: 200, body: { ok: 'yes' } })
    const error = await api(ok, 'GET', '/things').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('bad_reply')
    replies.push({ status: 200, body: { ok: true, extra: 1 } })
    await expect(api(ok, 'GET', '/things')).rejects.toMatchObject({ code: 'bad_reply' })
  })

  it('throws the core’s status and code for other errors', async () => {
    replies.push({ status: 409, body: { error: { code: 'stale_hash', message: 'changed' } } })
    await expect(api(ok, 'GET', '/things')).rejects.toMatchObject({ status: 409, code: 'stale_hash' })
    expect(assign).not.toHaveBeenCalled()
  })

  it('sends a 401 to sign-in with the current path as next', async () => {
    replies.push({ status: 401, body: { error: { code: 'not_signed_in', message: 'Sign in' } } })
    await expect(api(ok, 'GET', '/things')).rejects.toMatchObject({ status: 401 })
    expect(assign).toHaveBeenCalledWith('/sign-in?next=%2Fb%2Fb1%2Finbox%3Ffilter%3Doverdue')
  })

  it('refuses a next that names another place', async () => {
    location('//evil.example/path')
    replies.push({ status: 401, body: { error: { code: 'not_signed_in', message: 'Sign in' } } })
    await expect(api(ok, 'GET', '/things')).rejects.toBeInstanceOf(ApiError)
    expect(assign).toHaveBeenCalledWith('/sign-in')
    expect(signInAddress('https://evil.example/x')).toBe('/sign-in')
    expect(signInAddress('/b/1/inbox')).toBe('/sign-in?next=%2Fb%2F1%2Finbox')
    expect(signInAddress('/sign-in?next=/x')).toBe('/sign-in')
  })

  it('accepts as next only a same-site path that starts with a single slash', () => {
    expect(safeNext('/b/1/inbox?filter=overdue')).toBe('/b/1/inbox?filter=overdue')
    for (const bad of [
      '//evil',
      '///evil',
      '/\\evil',
      'https://evil.example',
      'http://evil.example/x',
      'javascript:alert(1)',
      'evil',
      '',
      null,
      undefined,
      '/ok\nHost: evil',
    ]) {
      expect(safeNext(bad as string | null | undefined)).toBe('/')
    }
  })

  it('sends a 403 enrolment_required to the enrolment screen', async () => {
    replies.push({ status: 403, body: { error: { code: 'enrolment_required', message: 'Set up' } } })
    await expect(api(ok, 'GET', '/things')).rejects.toMatchObject({ status: 403, code: 'enrolment_required' })
    expect(assign).toHaveBeenCalledWith('/enrol')
  })

  it('reports a network failure as an ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    )
    await expect(api(ok, 'GET', '/things')).rejects.toMatchObject({ status: 0, code: 'network' })
  })
})
