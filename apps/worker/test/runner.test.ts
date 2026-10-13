import { describe, expect, it } from 'vitest'
import type { CoreClient } from '../src/core-client.ts'
import type { ModelClient, ModelRequest } from '../src/model.ts'
import { runJob, type JobHandler } from '../src/runner.ts'

function fakeCore(overrides: Partial<CoreClient> = {}): CoreClient & { posted: unknown[]; calls: string[] } {
  const posted: unknown[] = []
  const calls: string[] = []
  const core: CoreClient = {
    async startAttempt() {
      return {
        finished: false,
        attemptId: 'a',
        attemptNumber: 1,
        token: 'tok',
        input: { x: 1 },
        savedSteps: [],
        expectedResultType: 'test.echo',
        jobClass: 'interactive',
      }
    },
    async control() {
      return { cancelRequested: false, held: false }
    },
    async registerModelCall(_j, _t, input) {
      calls.push(`register:${input.step}`)
      return { outcome: 'send', callId: `call-${input.step}`, possibleDuplicate: false }
    },
    async checkpoint(_j, _t, callId) {
      calls.push(`checkpoint:${callId}`)
      return { costed: true }
    },
    async failCall(_j, _t, callId) {
      calls.push(`fail:${callId}`)
    },
    async postResult(_j, _t, p) {
      posted.push(p)
      return { status: 'applied' }
    },
    async jobDead() {},
    async reconcile() {
      return { marked: 0 }
    },
    ...overrides,
  }
  return Object.assign(core, { posted, calls })
}

const model: ModelClient & { sent: ModelRequest[] } = {
  sent: [],
  async send(request) {
    this.sent.push(request)
    return {
      text: `reply to ${request.messages[0]!.content}`,
      messageId: 'msg',
      requestId: 'req',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
  },
}

const handler: JobHandler = async (ctx) => {
  const a = await ctx.modelStep('one', {
    model: 'm',
    messages: [{ role: 'user', content: 'one' }],
    maxTokens: 10,
  })
  await ctx.checkStop()
  const b = await ctx.modelStep('two', {
    model: 'm',
    messages: [{ role: 'user', content: 'two' }],
    maxTokens: 10,
  })
  return { type: 'test.echo', result: [a.text, b.text] }
}
const deps = (core: CoreClient) => ({
  core,
  model,
  handlers: { 'test.echo': handler },
  workerId: 'w',
})

describe('running a job', () => {
  it('runs each step as a registered, sent and checkpointed model call, then posts the result', async () => {
    model.sent.length = 0
    const core = fakeCore()
    await runJob(deps(core), { id: 'j1', jobClass: 'interactive' })
    expect(core.calls).toEqual(['register:one', 'checkpoint:call-one', 'register:two', 'checkpoint:call-two'])
    expect(core.posted).toEqual([{ type: 'test.echo', result: ['reply to one', 'reply to two'] }])
  })

  it('sends nothing for a step the core says is already saved', async () => {
    model.sent.length = 0
    const core = fakeCore({
      async registerModelCall(_j, _t, input) {
        return input.step === 'one'
          ? { outcome: 'use_checkpoint', output: { text: 'saved one' } }
          : { outcome: 'send', callId: 'c2', possibleDuplicate: false }
      },
    })
    await runJob(deps(core), { id: 'j2', jobClass: 'interactive' })
    expect(model.sent.map((r) => r.messages[0]!.content)).toEqual(['two'])
    expect(core.posted).toEqual([{ type: 'test.echo', result: ['saved one', 'reply to two'] }])
  })

  it('stops quietly, posting nothing, when the core says cancelled or held', async () => {
    for (const outcome of ['cancelled', 'held'] as const) {
      model.sent.length = 0
      const core = fakeCore({
        async registerModelCall() {
          return { outcome }
        },
      })
      await expect(runJob(deps(core), { id: 'j3', jobClass: 'interactive' })).resolves.toBeUndefined()
      expect(model.sent).toHaveLength(0)
      expect(core.posted).toHaveLength(0)
    }
  })

  it('stops between steps when the control flags say so', async () => {
    model.sent.length = 0
    const core = fakeCore({
      async control() {
        return { cancelRequested: true, held: false }
      },
    })
    await runJob(deps(core), { id: 'j4', jobClass: 'interactive' })
    expect(model.sent.map((r) => r.messages[0]!.content)).toEqual(['one'])
    expect(core.posted).toHaveLength(0)
  })

  it('marks a failed request and lets the failure reach the queue, so the job is retried', async () => {
    const core = fakeCore()
    const failing: ModelClient = {
      async send() {
        throw new Error('provider overloaded')
      },
    }
    await expect(
      runJob({ ...deps(core), model: failing }, { id: 'j5', jobClass: 'interactive' }),
    ).rejects.toThrow('provider overloaded')
    expect(core.calls).toContain('fail:call-one')
  })

  it('does nothing for a job the core says is already finished', async () => {
    const core = fakeCore({
      async startAttempt() {
        return { finished: true, outcome: {} }
      },
    })
    await runJob(deps(core), { id: 'j6', jobClass: 'interactive' })
    expect(core.calls).toEqual([])
  })

  it('fails a job whose result type has no handler', async () => {
    const core = fakeCore({
      async startAttempt() {
        return {
          finished: false,
          attemptId: 'a',
          attemptNumber: 1,
          token: 't',
          input: {},
          savedSteps: [],
          expectedResultType: 'unknown.type',
          jobClass: 'interactive',
        }
      },
    })
    await expect(runJob(deps(core), { id: 'j7', jobClass: 'interactive' })).rejects.toThrow(
      /no handler for unknown.type/,
    )
  })
})
