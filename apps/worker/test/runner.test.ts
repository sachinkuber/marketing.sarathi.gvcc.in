import { describe, expect, it } from 'vitest'
import { CoreError, type CoreClient } from '../src/core-client.ts'
import { ModelRefusedError, type ModelClient, type ModelRequest } from '../src/model.ts'
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
    async unmarkedDead() {
      return []
    },
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
  checkpointRetryDelayMs: 1,
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

  it('marks a request the provider refused as failed and lets the failure reach the queue', async () => {
    const core = fakeCore()
    const refusing: ModelClient = {
      async send() {
        throw new ModelRefusedError(400, 'bad request')
      },
    }
    await expect(
      runJob({ ...deps(core), model: refusing }, { id: 'j5', jobClass: 'interactive' }),
    ).rejects.toThrow('bad request')
    expect(core.calls).toContain('fail:call-one')
  })

  it('leaves the call started when the request may have been answered (connection, timeout, 5xx, 408)', async () => {
    for (const error of [
      new TypeError('fetch failed'),
      new Error('Request timed out.'),
      new ModelRefusedError(529, 'overloaded'),
      new ModelRefusedError(408, 'request timeout'),
    ]) {
      const core = fakeCore()
      const failing: ModelClient = {
        async send() {
          throw error
        },
      }
      await expect(
        runJob({ ...deps(core), model: failing }, { id: 'j5b', jobClass: 'interactive' }),
      ).rejects.toThrow(error.message)
      expect(core.calls.filter((c) => c.startsWith('fail:'))).toEqual([])
    }
  })

  it('keeps the provider error when marking the failure itself fails', async () => {
    const core = fakeCore({
      async failCall() {
        throw new Error('core unreachable')
      },
    })
    const refusing: ModelClient = {
      async send() {
        throw new ModelRefusedError(422, 'unprocessable')
      },
    }
    await expect(
      runJob({ ...deps(core), model: refusing }, { id: 'j5c', jobClass: 'interactive' }),
    ).rejects.toThrow('unprocessable')
  })

  it('checks for a cancel before it posts the result, and posts nothing when cancelled', async () => {
    model.sent.length = 0
    let reads = 0
    const core = fakeCore({
      async control() {
        reads += 1
        // Not cancelled between the steps; cancelled by the time the handler is done.
        return { cancelRequested: reads >= 2, held: false }
      },
    })
    await runJob(deps(core), { id: 'j8', jobClass: 'interactive' })
    expect(model.sent).toHaveLength(2)
    expect(core.posted).toHaveLength(0)
  })

  it('still posts the result when the job is held at post time, so the core keeps it as held', async () => {
    model.sent.length = 0
    let reads = 0
    const core = fakeCore({
      async control() {
        reads += 1
        // Free between the steps; held by the time the handler is done.
        return { cancelRequested: false, held: reads >= 2 }
      },
      async postResult(_j, _t, p) {
        core.posted.push(p)
        return { status: 'held' }
      },
    })
    await expect(runJob(deps(core), { id: 'j16', jobClass: 'interactive' })).resolves.toBeUndefined()
    expect(core.posted).toEqual([{ type: 'test.echo', result: ['reply to one', 'reply to two'] }])
  })

  it('stops between steps when the job is held', async () => {
    model.sent.length = 0
    const core = fakeCore({
      async control() {
        return { cancelRequested: false, held: true }
      },
    })
    await runJob(deps(core), { id: 'j17', jobClass: 'interactive' })
    expect(model.sent.map((r) => r.messages[0]!.content)).toEqual(['one'])
    expect(core.posted).toHaveLength(0)
  })

  it('ends quietly, without a retry, when the core refuses the result because the job was cancelled', async () => {
    const core = fakeCore({
      async postResult() {
        throw new CoreError(409, 'job_cancelled', 'This job was cancelled.')
      },
    })
    await expect(runJob(deps(core), { id: 'j9', jobClass: 'interactive' })).resolves.toBeUndefined()
  })

  it('still rethrows another refusal of the result', async () => {
    const core = fakeCore({
      async postResult() {
        throw new CoreError(409, 'job_not_active', 'no')
      },
    })
    await expect(runJob(deps(core), { id: 'j10', jobClass: 'interactive' })).rejects.toThrow('no')
  })

  it('repeats a checkpoint post that failed in transit, without sending the request again', async () => {
    model.sent.length = 0
    let tries = 0
    const core = fakeCore({
      async checkpoint(_j, _t, callId) {
        tries += 1
        if (tries <= 2) throw tries === 1 ? new TypeError('fetch failed') : new CoreError(503, 'down', 'down')
        core.calls.push(`checkpoint:${callId}`)
        return { costed: true }
      },
    })
    await runJob(deps(core), { id: 'j11', jobClass: 'interactive' })
    expect(model.sent.map((r) => r.messages[0]!.content)).toEqual(['one', 'two'])
    expect(core.calls).toEqual(['register:one', 'checkpoint:call-one', 'register:two', 'checkpoint:call-two'])
    expect(core.posted).toHaveLength(1)
  })

  it('does not repeat a checkpoint the core refused with a 4xx', async () => {
    let tries = 0
    const core = fakeCore({
      async checkpoint() {
        tries += 1
        throw new CoreError(403, 'attempt_refused', 'superseded')
      },
    })
    await expect(runJob(deps(core), { id: 'j12', jobClass: 'interactive' })).rejects.toThrow('superseded')
    expect(tries).toBe(1)
  })

  it('gives up on a checkpoint after five tries', async () => {
    let tries = 0
    const core = fakeCore({
      async checkpoint() {
        tries += 1
        throw new CoreError(500, 'error', 'broken')
      },
    })
    await expect(runJob(deps(core), { id: 'j13', jobClass: 'interactive' })).rejects.toThrow('broken')
    expect(tries).toBe(5)
  })

  it('hashes the same request the same way whatever the message object shape or an empty system', async () => {
    const hashes: string[] = []
    const core = fakeCore({
      async registerModelCall(_j, _t, input) {
        hashes.push(input.requestHash)
        return { outcome: 'use_checkpoint', output: { text: 'x' } }
      },
    })
    const run = (system: string | undefined, extra: Record<string, unknown>) =>
      runJob(
        {
          ...deps(core),
          handlers: {
            'test.echo': async (ctx) => {
              await ctx.modelStep('s', {
                model: 'm',
                ...(system === undefined ? {} : { system }),
                messages: [{ content: 'hi', role: 'user', ...extra }],
                maxTokens: 10,
              })
              return { type: 'test.echo', result: null }
            },
          },
        },
        { id: 'j14', jobClass: 'interactive' },
      )
    await run(undefined, {})
    await run('', {})
    await run(undefined, { ignored: true })
    await run('real system', {})
    expect(hashes[0]).toBe(hashes[1])
    expect(hashes[0]).toBe(hashes[2])
    expect(hashes[3]).not.toBe(hashes[0])
  })

  it('sends no system prompt when it is empty', async () => {
    model.sent.length = 0
    const core = fakeCore()
    await runJob(
      {
        ...deps(core),
        handlers: {
          'test.echo': async (ctx) => {
            await ctx.modelStep('s', {
              model: 'm',
              system: '',
              messages: [{ role: 'user', content: 'hi' }],
              maxTokens: 10,
            })
            return { type: 'test.echo', result: null }
          },
        },
      },
      { id: 'j15', jobClass: 'interactive' },
    )
    expect('system' in model.sent[0]!).toBe(false)
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
