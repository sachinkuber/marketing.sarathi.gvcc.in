import { describe, expect, it, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { isDefiniteRefusal, ModelRefusedError } from '../src/model.ts'
import { anthropicModel, DEFAULT_MODEL_TIMEOUT_MS } from '../src/anthropic.ts'

function fake(seen: Record<string, unknown>[]) {
  return (options: { apiKey: string; maxRetries: number; timeout: number }) => {
    seen.push(options)
    return {
      messages: {
        create: async () => ({
          id: 'msg_1',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    } as unknown as Anthropic
  }
}

describe('anthropicModel', () => {
  it('sets a request timeout under the shortest class expiry, no retries', async () => {
    const seen: Record<string, unknown>[] = []
    const model = anthropicModel('key', { makeClient: fake(seen) })
    await model.send({ model: 'm', maxTokens: 1, messages: [{ role: 'user', content: 'x' }] })
    expect(seen).toEqual([{ apiKey: 'key', maxRetries: 0, timeout: DEFAULT_MODEL_TIMEOUT_MS }])
    expect(DEFAULT_MODEL_TIMEOUT_MS).toBeLessThan(300_000)
  })

  it('takes the timeout from the caller', () => {
    const seen: Record<string, unknown>[] = []
    anthropicModel('key', { timeoutMs: 1000, makeClient: fake(seen) })
    expect(seen[0]?.timeout).toBe(1000)
  })

  function recording(reply: Record<string, unknown> = {}) {
    const bodies: Record<string, unknown>[] = []
    const calls: string[] = []
    const answer = async (body: Record<string, unknown>) => {
      bodies.push(body)
      return {
        id: 'msg_1',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        ...reply,
      }
    }
    const makeClient = () =>
      ({
        messages: {
          create: async (body: Record<string, unknown>) => {
            calls.push('create')
            return answer(body)
          },
          stream: (body: Record<string, unknown>) => {
            calls.push('stream')
            return { finalMessage: () => answer(body) }
          },
        },
      }) as unknown as Anthropic
    return { bodies, calls, makeClient }
  }
  const base = { model: 'm', maxTokens: 5, messages: [{ role: 'user' as const, content: 'x' }] }

  it('sends effort and the output format exactly as the port gives them, and returns the stop reason', async () => {
    const { bodies, makeClient } = recording()
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
    const reply = await anthropicModel('key', { makeClient }).send({
      ...base,
      system: 'sys',
      effort: 'low',
      outputSchema: schema,
    })
    expect(bodies[0]).toEqual({
      model: 'm',
      max_tokens: 5,
      system: 'sys',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      messages: base.messages,
    })
    expect(reply.stopReason).toBe('end_turn')
  })

  it('sends only what was asked for', async () => {
    const { bodies, makeClient } = recording()
    const model = anthropicModel('key', { makeClient })
    await model.send(base)
    await model.send({ ...base, effort: 'high' })
    await model.send({ ...base, outputSchema: { type: 'object' } })
    expect('output_config' in bodies[0]!).toBe(false)
    expect(bodies[1]!.output_config).toEqual({ effort: 'high' })
    expect(bodies[2]!.output_config).toEqual({ format: { type: 'json_schema', schema: { type: 'object' } } })
  })

  it('returns a null stop reason when the provider gave none', async () => {
    const { makeClient } = recording({ stop_reason: undefined })
    expect((await anthropicModel('key', { makeClient }).send(base)).stopReason).toBeNull()
  })

  it('sends web tools with names and max_uses', async () => {
    const { bodies, calls, makeClient } = recording()
    await anthropicModel('key', { makeClient }).send({
      ...base,
      tools: [
        { type: 'web_search_20260209', maxUses: 12 },
        { type: 'web_fetch_20260209', maxUses: 3 },
      ],
    })
    expect(bodies[0]!.tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 12 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 },
    ])
    // Tools: streamed, and read as the final message.
    expect(calls).toEqual(['stream'])
  })

  it('sends a request without tools as a plain create call', async () => {
    const { calls, makeClient } = recording()
    await anthropicModel('key', { makeClient }).send(base)
    expect(calls).toEqual(['create'])
  })

  it('turns an HTTP error thrown by the stream into a refusal', async () => {
    const makeClient = () =>
      ({
        messages: {
          stream: () => ({
            finalMessage: async () => {
              throw new Anthropic.APIError(429, { type: 'error' }, 'slow down', new Headers())
            },
          }),
        },
      }) as unknown as Anthropic
    const error = await anthropicModel('key', { makeClient })
      .send({ ...base, tools: [{ type: 'web_search_20260209', maxUses: 1 }] })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelRefusedError)
    expect((error as ModelRefusedError).status).toBe(429)
  })

  it('maps server_tool_use counts into usage, 0 when absent', async () => {
    const withCounts = recording({
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        server_tool_use: { web_search_requests: 4, web_fetch_requests: 2 },
      },
    })
    const a = await anthropicModel('key', { makeClient: withCounts.makeClient }).send(base)
    expect(a.usage).toMatchObject({ serverToolSearches: 4, serverToolFetches: 2 })
    const none = recording()
    const b = await anthropicModel('key', { makeClient: none.makeClient }).send(base)
    expect(b.usage).toMatchObject({ serverToolSearches: 0, serverToolFetches: 0 })
  })

  it('returns raw content blocks and sends block arrays back as an assistant turn', async () => {
    const blocks = [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }]
    const { bodies, makeClient } = recording({ content: blocks, stop_reason: 'pause_turn' })
    const model = anthropicModel('key', { makeClient })
    const reply = await model.send(base)
    expect(reply.content).toEqual(blocks)
    expect(reply.stopReason).toBe('pause_turn')
    await model.send({ ...base, messages: [...base.messages, { role: 'assistant', content: blocks }] })
    expect((bodies[1]!.messages as unknown[])[1]).toEqual({ role: 'assistant', content: blocks })
  })

  it('uses the request timeout for that request only', async () => {
    const options: { timeout?: number; signal?: AbortSignal }[] = []
    const makeClient = () =>
      ({
        messages: {
          create: async (_body: unknown, opts: { timeout?: number; signal?: AbortSignal }) => {
            options.push(opts)
            return { id: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1 } }
          },
        },
      }) as unknown as Anthropic
    const model = anthropicModel('key', { makeClient })
    await model.send({ ...base, timeoutMs: 900_000 })
    await model.send(base)
    expect(options[0]!.timeout).toBe(900_000)
    expect('timeout' in options[1]!).toBe(false)
    // Every request also carries the adapter's own abort signal, which bounds the whole request.
    for (const o of options) expect(o.signal).toBeInstanceOf(AbortSignal)
  })

  // The SDK's timeout covers only the wait for the response headers (its timer is cleared once fetch resolves),
  // so a stream that sends its headers and then never ends would hold the request forever without a bound
  // of the adapter's own.
  function hanging() {
    const seen: { signal?: AbortSignal }[] = []
    const makeClient = () =>
      ({
        messages: {
          stream: (_body: unknown, opts: { signal?: AbortSignal }) => {
            seen.push(opts ?? {})
            return {
              // Headers came; the body never ends. Only an abort ends it, as the SDK's MessageStream does.
              finalMessage: () =>
                new Promise((_resolve, reject) => {
                  opts?.signal?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()))
                }),
            }
          },
        },
      }) as unknown as Anthropic
    return { seen, makeClient }
  }
  const tools = [{ type: 'web_search_20260209' as const, maxUses: 1 }]

  it('a stream that sends its headers and never ends is cut at the request timeout, as a timeout', async () => {
    const { makeClient } = hanging()
    const started = Date.now()
    const outcome = await Promise.race([
      anthropicModel('key', { makeClient })
        .send({ ...base, tools, timeoutMs: 150 })
        .then(
          () => 'resolved',
          (e: unknown) => e,
        ),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 3000)),
    ])
    const took = Date.now() - started
    expect(outcome).not.toBe('still waiting')
    expect(took).toBeGreaterThanOrEqual(140)
    expect(took).toBeLessThan(2000)
    // The same error the SDK throws when the headers do not come in time, so the runner treats it the same way:
    // not a definite refusal, the call stays started for reconciliation.
    expect(outcome).toBeInstanceOf(Anthropic.APIConnectionTimeoutError)
    expect(isDefiniteRefusal(outcome)).toBe(false)
  })

  it('the client default timeout bounds a stream too when the request names none', async () => {
    const { makeClient } = hanging()
    const outcome = await Promise.race([
      anthropicModel('key', { makeClient, timeoutMs: 150 })
        .send({ ...base, tools })
        .catch((e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 3000)),
    ])
    expect(outcome).toBeInstanceOf(Anthropic.APIConnectionTimeoutError)
  })

  it('clears its timer once the request ends, whether it answered or failed', async () => {
    vi.useFakeTimers()
    try {
      const { makeClient } = recording()
      await anthropicModel('key', { makeClient }).send({ ...base, tools, timeoutMs: 60_000 })
      expect(vi.getTimerCount()).toBe(0)
      const failing = () =>
        ({
          messages: {
            create: async () => {
              throw new Anthropic.APIError(400, { type: 'error' }, 'bad request', new Headers())
            },
          },
        }) as unknown as Anthropic
      await anthropicModel('key', { makeClient: failing })
        .send({ ...base, timeoutMs: 60_000 })
        .catch(() => {})
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a caller abort that is not the timer passes through unchanged', async () => {
    const makeClient = () =>
      ({
        messages: {
          stream: () => ({
            finalMessage: async () => {
              throw new Anthropic.APIUserAbortError()
            },
          }),
        },
      }) as unknown as Anthropic
    const error = await anthropicModel('key', { makeClient })
      .send({ ...base, tools, timeoutMs: 60_000 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Anthropic.APIUserAbortError)
    expect(error).not.toBeInstanceOf(Anthropic.APIConnectionTimeoutError)
  })

  it('sends max_content_tokens on web_fetch when the definition gives it', async () => {
    const { bodies, makeClient } = recording()
    await anthropicModel('key', { makeClient }).send({
      ...base,
      tools: [
        { type: 'web_search_20260209', maxUses: 12 },
        { type: 'web_fetch_20260209', maxUses: 3, maxContentTokens: 40_000 },
      ],
    })
    expect(bodies[0]!.tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 12 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3, max_content_tokens: 40_000 },
    ])
  })

  it('still turns an HTTP 400 into a refusal', async () => {
    const makeClient = () =>
      ({
        messages: {
          create: async () => {
            throw new Anthropic.APIError(400, { type: 'error' }, 'bad request', new Headers())
          },
        },
      }) as unknown as Anthropic
    const error = await anthropicModel('key', { makeClient })
      .send(base)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelRefusedError)
    expect((error as ModelRefusedError).status).toBe(400)
  })
})
