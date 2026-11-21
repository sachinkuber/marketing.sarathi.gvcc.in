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
    for (const outcome of ['held', 'superseded', 'waiting_for_answer']) {
      expect(replySchemas.startAttempt.safeParse({ finished: false, outcome }).success).toBe(true)
    }
    expect(replySchemas.startAttempt.safeParse({ finished: false, outcome: 'other' }).success).toBe(false)
    const started = {
      finished: false,
      attemptId: 'a',
      attemptNumber: 1,
      token: 't',
      input: {},
      savedSteps: [],
      expectedResultType: 'x',
      jobClass: 'interactive',
      agent: 'summary',
      filesHash: 'abc',
    }
    expect(replySchemas.startAttempt.safeParse(started).success).toBe(true)
    expect(replySchemas.startAttempt.safeParse({ ...started, token: undefined }).success).toBe(false)
    expect(replySchemas.startAttempt.safeParse({ ...started, jobClass: 'other' }).success).toBe(false)
    expect(replySchemas.startAttempt.safeParse({ ...started, agent: null, filesHash: null }).success).toBe(
      true,
    )
    expect(replySchemas.startAttempt.safeParse({ ...started, agent: undefined }).success).toBe(false)
    // The owner's answers to the job's questions; absent from a core that does not send them.
    const answers = [{ question: 'Which city?', why: 'Two are named.', options: ['Pune'], answer: 'Pune' }]
    expect(replySchemas.startAttempt.safeParse({ ...started, answers }).success).toBe(true)
    expect(replySchemas.startAttempt.safeParse({ ...started, answers: [{ question: 'q' }] }).success).toBe(
      false,
    )
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

  it('reads an approvals tick reply and rejects a malformed one', async () => {
    const ok = { reminded: 1, overdue: 2, escalated: 0, failedBrands: 0 }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(ok), { status: 200 }))
    expect(await httpCoreClient('http://core.test', 'secret').approvalsTick('w-1')).toEqual(ok)
    for (const bad of [
      { reminded: 1, overdue: 2, escalated: 0 },
      { ...ok, overdue: -1 },
      { ...ok, reminded: 1.5 },
    ]) {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify(bad), { status: 200 }))
      await expect(httpCoreClient('http://core.test', 'secret').approvalsTick('w-1')).rejects.toThrow(
        /unexpected reply/,
      )
    }
  })

  it('posts the approvals tick with the worker credential', async () => {
    const seen: { url: string; method?: string; auth?: string; body?: unknown }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({
        url,
        method: init.method,
        auth: (init.headers as Record<string, string>).authorization,
        body: JSON.parse(String(init.body)),
      })
      return new Response(JSON.stringify({ reminded: 0, overdue: 0, escalated: 0, failedBrands: 0 }), {
        status: 200,
      })
    })
    await httpCoreClient('http://core.test', 'secret').approvalsTick('w-1')
    expect(seen).toEqual([
      {
        url: 'http://core.test/api/v1/worker/approvals/tick',
        method: 'POST',
        auth: 'Worker secret',
        body: { workerId: 'w-1' },
      },
    ])
  })

  it('ends a held attempt with the attempt token', async () => {
    const seen: { url: string; method?: string; token?: string; body?: unknown }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({
        url,
        method: init.method,
        token: (init.headers as Record<string, string>)['x-attempt-token'],
        body: JSON.parse(init.body as string),
      })
      return new Response(null, { status: 204 })
    })
    await httpCoreClient('http://core.test', 'secret').endAttempt('j1', 'tok', 'held')
    expect(seen).toEqual([
      {
        url: 'http://core.test/api/v1/worker/jobs/j1/attempt/end',
        method: 'POST',
        token: 'tok',
        body: { reason: 'held' },
      },
    ])
  })

  it('reads a document as its stored type and bytes, and raises the core error when there is none', async () => {
    const seen: { url: string; token?: string }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, token: (init.headers as Record<string, string>)['x-attempt-token'] })
      return url.endsWith('/missing')
        ? new Response(JSON.stringify({ error: { code: 'not_found', message: 'nothing' } }), { status: 404 })
        : new Response(Buffer.from('%PDF-1.7 body'), {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          })
    })
    const client = httpCoreClient('http://core.test', 'secret')
    const got = await client.document('j1', 'tok', 'd1')
    expect(got.mediaType).toBe('application/pdf')
    expect(got.bytes.toString()).toBe('%PDF-1.7 body')
    expect(seen[0]).toEqual({ url: 'http://core.test/api/v1/worker/jobs/j1/documents/d1', token: 'tok' })
    await expect(client.document('j1', 'tok', 'missing')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })
  })
  it("lists a job's documents and reads a part with its page range", async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url)
      if (url.endsWith('/documents')) {
        return new Response(
          JSON.stringify([
            {
              id: 'd1',
              fileName: 'a.pdf',
              mediaType: 'application/pdf',
              sizeBytes: 9,
              parts: [{ partNo: 1, firstPage: 1, lastPage: 3, sizeBytes: 5 }],
            },
          ]),
          { status: 200 },
        )
      }
      return url.endsWith('/parts/9')
        ? new Response(JSON.stringify({ error: { code: 'not_found', message: 'nothing' } }), { status: 404 })
        : new Response(Buffer.from('%PDF part'), {
            status: 200,
            headers: { 'content-type': 'application/pdf', 'x-first-page': '4', 'x-last-page': '6' },
          })
    })
    const client = httpCoreClient('http://core.test', 'secret')
    expect((await client.documents('j1', 'tok'))[0]?.parts).toEqual([
      { partNo: 1, firstPage: 1, lastPage: 3, sizeBytes: 5 },
    ])
    const part = await client.documentPart('j1', 'tok', 'd1', 2)
    expect(part).toMatchObject({ firstPage: 4, lastPage: 6 })
    expect(part.bytes.toString()).toBe('%PDF part')
    expect(seen).toEqual([
      'http://core.test/api/v1/worker/jobs/j1/documents',
      'http://core.test/api/v1/worker/jobs/j1/documents/d1/parts/2',
    ])
    await expect(client.documentPart('j1', 'tok', 'd1', 9)).rejects.toMatchObject({ status: 404 })
  })
})
