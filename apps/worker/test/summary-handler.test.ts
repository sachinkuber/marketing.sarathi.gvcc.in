import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { wrapBrief } from '@mkt/shared'
import { type CoreClient } from '../src/core-client.ts'
import { ModelStopped, type ModelClient, type ModelRequest } from '../src/model.ts'
import { runJob, type JobContext } from '../src/runner.ts'
import { checkHandler } from '../src/agents/check.ts'
import { providerSchema, summaryHandler } from '../src/agents/summary.ts'

const good = { summary: 'One. Two.', keywords: ['a', 'b', 'c'] }
const agentFile = (name: string) =>
  readFileSync(new URL(`../../../agents/summary/${name}`, import.meta.url), 'utf8')

function stubContext(
  step: { text: string; stopReason?: string | null },
  input: unknown = { brief: 'Hello <b>' },
) {
  const requests: { step: string; request: ModelRequest }[] = []
  const ctx: JobContext = {
    jobId: 'j',
    jobClass: 'interactive',
    input,
    async modelStep(name, request) {
      requests.push({ step: name, request })
      return step
    },
    async checkStop() {},
  }
  return { ctx, requests }
}

describe('the summary handler', () => {
  it('returns summary.v1 for a valid JSON reply', async () => {
    const { ctx } = stubContext({ text: JSON.stringify(good), stopReason: 'end_turn' })
    expect(await summaryHandler(ctx)).toEqual({ type: 'summary.v1', result: good })
  })

  it('makes one step with the wrapped brief alone, the stored system prompt, low effort and the schema', async () => {
    const { ctx, requests } = stubContext({ text: JSON.stringify(good), stopReason: 'end_turn' })
    await summaryHandler(ctx)
    expect(requests).toHaveLength(1)
    const { step, request } = requests[0]!
    expect(step).toBe('summarise')
    expect(request.messages).toEqual([{ role: 'user', content: wrapBrief('Hello <b>') }])
    expect(request.system).toBe(agentFile('system.md'))
    expect(request.model).toBe('claude-opus-5-5')
    expect(request.effort).toBe('low')
    expect(request.maxTokens).toBe(1024)
    expect(request.outputSchema).toEqual(providerSchema(JSON.parse(agentFile('output.schema.json'))))
  })

  it.each([
    ['invalid JSON', { text: 'not json', stopReason: 'end_turn' }, 'SummaryReplyInvalid'],
    [
      'four keywords',
      { text: JSON.stringify({ ...good, keywords: ['a', 'b', 'c', 'd'] }) },
      'SummaryReplyInvalid',
    ],
    ['U+200B', { text: JSON.stringify({ ...good, summary: 'a​b' }) }, 'SummaryReplyInvalid'],
    ['an extra field', { text: JSON.stringify({ ...good, more: 1 }) }, 'SummaryReplyInvalid'],
    ['max_tokens', { text: JSON.stringify(good), stopReason: 'max_tokens' }, 'ModelStopped'],
  ])('throws on %s and names the error without the text', async (_name, step, name) => {
    const { ctx } = stubContext(step)
    const error = await summaryHandler(ctx).catch((e: unknown) => e)
    expect((error as Error).name).toBe(name)
    expect((error as Error).message).not.toContain('not json')
    expect((error as Error).message).not.toContain('u200b')
  })

  it('refuses an input that is not a brief', async () => {
    const { ctx } = stubContext({ text: '{}' }, { brief: '' })
    await expect(summaryHandler(ctx)).rejects.toThrow()
  })
})

describe('the summary handler through the runner', () => {
  function run(text: string, stopReason: string) {
    const posted: unknown[] = []
    const calls: string[] = []
    const core = {
      async startAttempt() {
        return {
          finished: false,
          attemptId: 'a',
          attemptNumber: 1,
          token: 't',
          input: { brief: 'a brief' },
          savedSteps: [],
          expectedResultType: 'summary.v1',
          jobClass: 'interactive',
        }
      },
      async control() {
        return { cancelRequested: false, held: false }
      },
      async registerModelCall() {
        return { outcome: 'send', callId: 'c', possibleDuplicate: false }
      },
      async checkpoint() {
        calls.push('checkpoint')
        return { costed: true }
      },
      async postResult(_j: string, _t: string, p: unknown) {
        posted.push(p)
        return { status: 'applied' }
      },
    } as unknown as CoreClient
    const model: ModelClient = {
      async send() {
        return {
          text,
          messageId: 'm',
          requestId: null,
          stopReason,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }
      },
    }
    const done = runJob(
      { core, model, handlers: { 'summary.v1': summaryHandler }, workerId: 'w' },
      { id: 'j', jobClass: 'interactive' },
    )
    return { done, posted, calls }
  }

  it('posts a valid result', async () => {
    const r = run(JSON.stringify(good), 'end_turn')
    await r.done
    expect(r.posted).toEqual([{ type: 'summary.v1', result: good }])
  })

  it.each([
    ['invalid JSON', 'nope', 'end_turn'],
    ['four keywords', JSON.stringify({ ...good, keywords: ['a', 'b', 'c', 'd'] }), 'end_turn'],
    ['U+200B', JSON.stringify({ ...good, summary: 'a​b' }), 'end_turn'],
  ])('posts nothing for %s', async (_n, text, stopReason) => {
    const r = run(text, stopReason)
    await expect(r.done).rejects.toThrow()
    expect(r.posted).toEqual([])
  })

  it('posts nothing and saves no checkpoint when the reply was cut off', async () => {
    const r = run(JSON.stringify(good), 'max_tokens')
    await expect(r.done).rejects.toBeInstanceOf(ModelStopped)
    expect(r.posted).toEqual([])
    expect(r.calls).toEqual([])
  })
})

describe('the provider schema', () => {
  const stored = JSON.parse(agentFile('output.schema.json')) as Record<string, unknown>
  const banned = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'pattern']
  const keysOf = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap(keysOf)
      : value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)])
        : []

  it('carries none of the keywords the provider does not support, at any depth', () => {
    const reduced = providerSchema(stored)
    expect(keysOf(stored).some((k) => banned.includes(k))).toBe(true)
    expect(keysOf(reduced).filter((k) => banned.includes(k))).toEqual([])
  })

  it('keeps the shape: types, properties, required and additionalProperties false', () => {
    const reduced = providerSchema(stored) as {
      type: string
      required: string[]
      additionalProperties: boolean
      properties: Record<string, unknown>
    }
    expect(reduced.type).toBe('object')
    expect(reduced.required).toEqual(['summary', 'keywords'])
    expect(reduced.additionalProperties).toBe(false)
    expect(Object.keys(reduced.properties)).toEqual(['summary', 'keywords'])
    expect(reduced.properties.summary).toEqual({ type: 'string' })
    expect(reduced.properties.keywords).toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('does not change the stored schema, and does not strip a property that is named like a keyword', () => {
    const before = JSON.stringify(stored)
    providerSchema(stored)
    expect(JSON.stringify(stored)).toBe(before)
    const odd = providerSchema({ type: 'object', properties: { pattern: { type: 'string', pattern: 'x' } } })
    expect(odd).toEqual({ type: 'object', properties: { pattern: { type: 'string' } } })
  })
})

describe('the check handler', () => {
  it('makes no model call and returns the version id for the core to check', async () => {
    const { ctx, requests } = stubContext({ text: '' }, { versionId: 'v-1' })
    expect(await checkHandler(ctx)).toEqual({ type: 'placeholder_check.v1', result: { versionId: 'v-1' } })
    expect(requests).toEqual([])
  })

  it('refuses an input without a version id', async () => {
    const { ctx } = stubContext({ text: '' }, {})
    await expect(checkHandler(ctx)).rejects.toThrow()
  })
})
