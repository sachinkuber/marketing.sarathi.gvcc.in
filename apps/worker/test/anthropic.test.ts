import { describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
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
})
