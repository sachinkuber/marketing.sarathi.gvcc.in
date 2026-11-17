import { describe, expect, it, vi } from 'vitest'
import * as Sentry from '@sentry/node'
import type { ErrorEvent } from '@sentry/node'
vi.mock('@sentry/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/node')>()),
  init: vi.fn(),
}))

import { initErrorTracking, scrubEvent } from '../src/sentry.ts'

function event(extra: Record<string, unknown> = {}): ErrorEvent {
  return { type: undefined, ...extra } as ErrorEvent
}

describe('scrubEvent', () => {
  it('removes request data, cookies, query string and user', () => {
    const out = scrubEvent(
      event({
        request: {
          url: 'https://x.example/a?token=1',
          data: { name: 'Asha' },
          cookies: { sid: 'abc' },
          query_string: 'a=1',
          method: 'POST',
        },
        user: { id: '1', email: 'a@b.example', ip_address: '1.2.3.4' },
      }),
    )
    expect(out.request?.data).toBeUndefined()
    expect(out.request?.cookies).toBeUndefined()
    expect(out.request?.query_string).toBeUndefined()
    expect(out.user).toBeUndefined()
  })

  it('keeps only content-type and user-agent headers', () => {
    const out = scrubEvent(
      event({
        request: {
          headers: {
            'Content-Type': 'application/json',
            'user-agent': 'curl',
            authorization: 'Bearer x',
            cookie: 'sid=1',
            'x-forwarded-for': '1.2.3.4',
          },
        },
      }),
    )
    expect(out.request?.headers).toEqual({ 'Content-Type': 'application/json', 'user-agent': 'curl' })
  })

  it('replaces every email address in message, exception values and breadcrumbs with [email]', () => {
    const out = scrubEvent(
      event({
        message: 'failed for a@b.example and c.d+e@f.example.org',
        exception: { values: [{ type: 'Error', value: 'bounce from x@y.example' }] },
        breadcrumbs: [{ message: 'sent to p@q.example', data: { to: 'r@s.example' } }],
      }),
    )
    expect(out.message).toBe('failed for [email] and [email]')
    expect(out.exception?.values?.[0]?.value).toBe('bounce from [email]')
    expect(out.breadcrumbs?.[0]?.message).toBe('sent to [email]')
    expect(JSON.stringify(out)).not.toContain('@')
  })

  it('removes values of keys matching /secret|token|password|authorization|dsn|smtp/i at any depth', () => {
    const out = scrubEvent(
      event({
        extra: {
          ok: 'keep',
          authSecret: 's1',
          nested: { deep: [{ Password: 'p', fine: 1, smtpUrl: 'smtp://u:p@h' }] },
          SENTRY_DSN: 'https://k@h/1',
          accessToken: 't',
          Authorization: 'a',
        },
      }),
    )
    const extra = out.extra as {
      ok: string
      authSecret?: string
      nested: { deep: Record<string, unknown>[] }
    }
    expect(extra.ok).toBe('keep')
    expect(extra.nested.deep[0]?.fine).toBe(1)
    const text = JSON.stringify(out)
    for (const leaked of ['s1', '"p"', 'smtp://', 'https://k@h/1', '"t"', '"a"']) {
      expect(text).not.toContain(leaked)
    }
    expect(extra.authSecret).toBeUndefined()
    expect(extra.nested.deep[0]?.Password).toBeUndefined()
  })
})

describe('initErrorTracking', () => {
  it('without a dsn returns false and does not call Sentry.init', () => {
    const init = vi.mocked(Sentry.init)
    init.mockClear()
    expect(initErrorTracking({ service: 'core', release: 'r1' })).toBe(false)
    expect(init).not.toHaveBeenCalled()
  })

  it('with a dsn initialises with no personal data, no tracing and the scrubber', () => {
    const init = vi.mocked(Sentry.init)
    init.mockClear()
    expect(initErrorTracking({ dsn: 'https://k@h.example/1', service: 'worker', release: 'r1' })).toBe(true)
    const options = init.mock.calls[0]![0]!
    expect(options).toMatchObject({
      sendDefaultPii: false,
      tracesSampleRate: 0,
      release: 'r1',
      beforeSend: scrubEvent,
    })
    expect(options.beforeSendTransaction!({} as never, {})).toBeNull()
  })
})
