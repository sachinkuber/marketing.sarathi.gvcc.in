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
        user: { id: '1', email: 'a@b.example', ip_address: '192.0.2.4' },
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
            'x-forwarded-for': '192.0.2.4',
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

describe('scrubEvent urls, metadata and walk bounds', () => {
  it('strips the query string and fragment from request.url and breadcrumb urls', () => {
    const out = scrubEvent(
      event({
        request: { url: 'https://x.example/a/b?email=a%40b.example&x=1#frag' },
        breadcrumbs: [
          {
            category: 'http',
            data: {
              url: 'https://x.example/p?q=1',
              to: '/next?email=a%40b.example#h',
              from: '/prev?z=2',
              status_code: 200,
            },
          },
        ],
      }),
    )
    expect(out.request?.url).toBe('https://x.example/a/b')
    expect(out.breadcrumbs?.[0]?.data).toEqual({
      url: 'https://x.example/p',
      to: '/next',
      from: '/prev',
      status_code: 200,
    })
  })

  it('replaces percent-encoded email addresses too', () => {
    const out = scrubEvent(event({ message: 'bad value a%40b.example and C%40D.org' }))
    expect(out.message).toBe('bad value [email] and [email]')
  })

  it('removes sdkProcessingMetadata, even with class instances and cycles in it', () => {
    class Scope {
      client: unknown
    }
    const scope = new Scope()
    scope.client = { options: { dsn: 'x' }, scope }
    const out = scrubEvent(
      event({
        message: 'm',
        sdkProcessingMetadata: { capturedSpanScope: scope, normalizedRequest: { url: '/a?b=c' } },
      }),
    )
    expect(out.sdkProcessingMetadata).toBeUndefined()
    expect(out.message).toBe('m')
  })

  it('caps a deeply nested value without throwing', () => {
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 5000; i++) deep = { next: deep }
    const out = scrubEvent(event({ extra: { deep } }))
    expect(JSON.stringify(out)).toContain('[too deep]')
  })

  it('keeps an object referenced twice in different branches, and marks a true cycle', () => {
    const shared = { v: 1 }
    const cyc: Record<string, unknown> = { name: 'c' }
    cyc.self = cyc
    const out = scrubEvent(event({ extra: { a: shared, b: shared, cyc } }))
    const extra = out.extra as { a: unknown; b: unknown; cyc: { self: unknown } }
    expect(extra.a).toEqual({ v: 1 })
    expect(extra.b).toEqual({ v: 1 })
    expect(extra.cyc.self).toBe('[circular]')
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

  // Sentry's default rejection handler only warns, and once any listener exists Node no longer exits on an
  // unhandled rejection. Strict mode reports the rejection and then exits with code 1, as Node would.
  it('replaces the unhandled-rejection integration with one that exits the process (strict mode)', () => {
    const init = vi.mocked(Sentry.init)
    init.mockClear()
    initErrorTracking({ dsn: 'https://k@h.example/1', service: 'core', release: 'r1' })
    const integrations = init.mock.calls[0]![0]!.integrations
    expect(Array.isArray(integrations)).toBe(true)
    const rejection = (integrations as { name: string; setup?: (client: unknown) => void }[]).find(
      (integration) => integration.name === 'OnUnhandledRejection',
    )
    expect(rejection).toBeDefined()

    let handler: ((reason: unknown, promise: unknown) => void) | undefined
    const on = vi.spyOn(process, 'on').mockImplementation(((event: string, listener: never) => {
      if (event === 'unhandledRejection') handler = listener
      return process
    }) as never)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // No Sentry client exists here (init is mocked), so the handler takes the immediate-exit path.
      rejection!.setup!(undefined)
      expect(handler).toBeDefined()
      handler!(new Error('boom'), Promise.resolve())
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      on.mockRestore()
      exit.mockRestore()
      warn.mockRestore()
      error.mockRestore()
    }
  })
})
