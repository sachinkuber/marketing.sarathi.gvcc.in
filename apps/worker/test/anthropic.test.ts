import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { ModelRefusedError } from '../src/model.ts'
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
    const makeClient = () =>
      ({
        messages: {
          create: async (body: Record<string, unknown>) => {
            bodies.push(body)
            return {
              id: 'msg_1',
              content: [{ type: 'text', text: 'hi' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
              ...reply,
            }
          },
        },
      }) as unknown as Anthropic
    return { bodies, makeClient }
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
