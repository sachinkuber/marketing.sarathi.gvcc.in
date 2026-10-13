import { afterEach, describe, expect, it, vi } from 'vitest'
import { httpCoreClient, replySchemas } from '../src/core-client.ts'

describe('the replies the worker accepts from the core', () => {
  it('rejects an unknown registration outcome and a send without a call', () => {
    expect(replySchemas.registered.safeParse({ outcome: 'maybe' }).success).toBe(false)
    expect(replySchemas.registered.safeParse({ outcome: 'send', possibleDuplicate: false }).success).toBe(
      false,
    )
    expect(
      replySchemas.registered.safeParse({ outcome: 'send', callId: 'c', possibleDuplicate: true }).success,
    ).toBe(true)
  })

  it('accepts a reply with an extra field', () => {
    expect(replySchemas.registered.safeParse({ outcome: 'held', note: 'later' }).success).toBe(true)
    expect(replySchemas.control.safeParse({ cancelRequested: false, held: false, more: 1 }).success).toBe(
      true,
    )
    expect(replySchemas.postResult.safeParse({ status: 'applied', outcome: {} }).success).toBe(true)
  })

  it('rejects a control reply with a missing flag', () => {
    expect(replySchemas.control.safeParse({ held: false }).success).toBe(false)
    expect(replySchemas.control.safeParse({ cancelRequested: false }).success).toBe(false)
    expect(replySchemas.control.safeParse({}).success).toBe(false)
  })

  it('accepts both shapes of a start and rejects a malformed one', () => {
    expect(replySchemas.startAttempt.safeParse({ finished: true, outcome: { a: 1 } }).success).toBe(true)
    const started = {
      finished: false,
      attemptId: 'a',
      attemptNumber: 1,
      token: 't',
      input: {},
      savedSteps: [],
      expectedResultType: 'x',
      jobClass: 'interactive',
    }
    expect(replySchemas.startAttempt.safeParse(started).success).toBe(true)
    expect(replySchemas.startAttempt.safeParse({ ...started, token: undefined }).success).toBe(false)
    expect(replySchemas.startAttempt.safeParse({ ...started, jobClass: 'other' }).success).toBe(false)
  })

  it('rejects a checkpoint or result reply that is not understood', () => {
    expect(replySchemas.checkpoint.safeParse({}).success).toBe(false)
    expect(replySchemas.postResult.safeParse({ status: 'done' }).success).toBe(false)
  })
})

describe('the HTTP core client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fails, rather than reading "not cancelled", when the control reply lacks a flag', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ held: false }), { status: 200 }))
    await expect(httpCoreClient('http://core.test', 'secret').control('j', 't')).rejects.toThrow(
      /unexpected reply/,
    )
  })

  it('passes a valid control reply through', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ cancelRequested: true, held: false }), { status: 200 }),
    )
    expect(await httpCoreClient('http://core.test', 'secret').control('j', 't')).toEqual({
      cancelRequested: true,
      held: false,
    })
  })
})
