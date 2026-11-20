import { describe, expect, it } from 'vitest'
import { ModelStopped, type ModelRequest } from '../src/model.ts'
import { modelTurns } from '../src/model-turns.ts'
import type { JobContext, ModelStepResult } from '../src/runner.ts'

const usage = (searches: number, fetches = 0) => ({
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  serverToolSearches: searches,
  serverToolFetches: fetches,
})

function script(replies: ModelStepResult[]) {
  const seen: { step: string; request: ModelRequest }[] = []
  const ctx: JobContext = {
    jobId: 'j',
    jobClass: 'production',
    input: null,
    async modelStep(step, request) {
      seen.push({ step, request })
      const next = replies[seen.length - 1]
      if (!next) throw new Error('script ran out')
      return next
    },
    async checkStop() {},
  }
  return { ctx, seen }
}

const request: ModelRequest = {
  model: 'm',
  maxTokens: 10,
  messages: [{ role: 'user', content: 'research' }],
  tools: [
    { type: 'web_search_20260209', maxUses: 20 },
    { type: 'web_fetch_20260209', maxUses: 10 },
  ],
}

describe('modelTurns', () => {
  it('pause_turn continues with the remaining budget', async () => {
    const blocks = [{ type: 'server_tool_use', name: 'web_search' }]
    const { ctx, seen } = script([
      { text: 'part', stopReason: 'pause_turn', content: blocks, usage: usage(8) },
      { text: 'done', stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: usage(5) },
    ])
    const out = await modelTurns(ctx, 'dig', request, { searches: 20, fetches: 10, maxContinuations: 6 })
    expect(seen.map((s) => s.step)).toEqual(['dig#0', 'dig#1'])
    expect(seen[0]!.request.tools).toEqual(request.tools)
    expect(seen[1]!.request.tools).toEqual([
      { type: 'web_search_20260209', maxUses: 12 },
      { type: 'web_fetch_20260209', maxUses: 10 },
    ])
    // The assistant content goes back as is, with no "continue" message.
    expect(seen[1]!.request.messages).toEqual([
      { role: 'user', content: 'research' },
      { role: 'assistant', content: blocks },
    ])
    expect(out.text).toBe('done')
    expect(out.searches).toBe(13)
    expect(out.fetches).toBe(0)
  })

  it('a spent search budget drops the search tool', async () => {
    const { ctx, seen } = script([
      { text: '', stopReason: 'pause_turn', content: [], usage: usage(20, 3) },
      { text: 'ok', stopReason: 'end_turn', content: [], usage: usage(0) },
    ])
    await modelTurns(ctx, 'dig', request, { searches: 20, fetches: 10, maxContinuations: 6 })
    expect(seen[1]!.request.tools).toEqual([{ type: 'web_fetch_20260209', maxUses: 7 }])
  })

  it('too many continuations stop with cap_reached', async () => {
    const pause: ModelStepResult = { text: '', stopReason: 'pause_turn', content: [], usage: usage(0) }
    const { ctx, seen } = script([pause, pause, pause, pause])
    const error = await modelTurns(ctx, 'dig', request, {
      searches: 20,
      fetches: 10,
      maxContinuations: 2,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelStopped)
    expect((error as ModelStopped).stopReason).toBe('cap_reached')
    expect(seen).toHaveLength(3)
  })

  it('any other stop reason stops with that reason', async () => {
    const { ctx } = script([{ text: 'cut', stopReason: 'max_tokens', content: [], usage: usage(0) }])
    const error = await modelTurns(ctx, 'dig', request, {
      searches: 1,
      fetches: 1,
      maxContinuations: 6,
    }).catch((e: unknown) => e)
    expect((error as ModelStopped).stopReason).toBe('max_tokens')
  })
})
