import { describe, expect, it } from 'vitest'
import { CoreError, type CoreClient } from '../src/core-client.ts'
import { ModelRefusedError, ModelStopped, type ModelClient, type ModelRequest } from '../src/model.ts'
import { modelTurns } from '../src/model-turns.ts'
import { runJob, type JobHandler } from '../src/runner.ts'

function fakeCore(
  overrides: Partial<CoreClient> = {},
): CoreClient & { posted: unknown[]; calls: string[]; ended: string[] } {
  const posted: unknown[] = []
  const calls: string[] = []
  const ended: string[] = []
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
        agent: null,
        filesHash: null,
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
    async endAttempt(jobId, _t, reason) {
      ended.push(`${jobId}:${reason}`)
    },
    async document() {
      throw new Error('no document in this test')
    },
    async documents() {
      return []
    },
    async documentPart() {
      throw new Error('no document in this test')
    },
    async jobDead() {},
    async unmarkedDead() {
      return []
    },
    async reconcile() {
      return { marked: 0 }
    },
    async approvalsTick() {
      return { reminded: 0, overdue: 0, escalated: 0, failedBrands: 0 }
    },
    ...overrides,
  }
  return Object.assign(core, { posted, calls, ended })
}

const model: ModelClient & { sent: ModelRequest[] } = {
  sent: [],
  async send(request) {
    this.sent.push(request)
    return {
      text: `reply to ${request.messages[0]!.content}`,
      messageId: 'msg',
      requestId: 'req',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
  },
}

// A registry entry for a handler that loads no agent files.
const plain = (handler: JobHandler) => ({ handler, agent: null, filesHash: null })

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
  handlers: { 'test.echo': plain(handler) },
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
            'test.echo': plain(async (ctx) => {
              await ctx.modelStep('s', {
                model: 'm',
                ...(system === undefined ? {} : { system }),
                messages: [{ content: 'hi', role: 'user', ...extra }],
                maxTokens: 10,
              })
              return { type: 'test.echo', result: null }
            }),
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
          'test.echo': plain(async (ctx) => {
            await ctx.modelStep('s', {
              model: 'm',
              system: '',
              messages: [{ role: 'user', content: 'hi' }],
              maxTokens: 10,
            })
            return { type: 'test.echo', result: null }
          }),
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
          agent: null,
          filesHash: null,
        }
      },
    })
    await expect(runJob(deps(core), { id: 'j7', jobClass: 'interactive' })).rejects.toThrow(
      /no handler for unknown.type/,
    )
  })

  it('ends the attempt once when it stops because the job is held, and not when it was cancelled', async () => {
    for (const [outcome, expected] of [
      ['held', ['jh:held']],
      ['cancelled', []],
    ] as const) {
      const core = fakeCore({
        async registerModelCall() {
          return { outcome }
        },
      })
      await runJob(deps(core), { id: 'jh', jobClass: 'interactive' })
      expect(core.ended).toEqual(expected)
    }
  })

  it('ends the attempt when a held job is found between steps', async () => {
    const core = fakeCore({
      async control() {
        return { cancelRequested: false, held: true }
      },
    })
    await runJob(deps(core), { id: 'jh', jobClass: 'interactive' })
    expect(core.ended).toEqual(['jh:held'])
  })

  it('still stops quietly when ending a held attempt fails', async () => {
    const core = fakeCore({
      async control() {
        return { cancelRequested: false, held: true }
      },
      async endAttempt() {
        throw new CoreError(500, 'error', 'down')
      },
    })
    await expect(runJob(deps(core), { id: 'jh2', jobClass: 'interactive' })).resolves.toBeUndefined()
  })

  it('costs a reply that did not end its turn with a cost-only checkpoint, then throws ModelStopped', async () => {
    const stopped: ModelClient = {
      async send() {
        return {
          text: '{"cut":',
          messageId: 'm-stop',
          requestId: 'r-stop',
          stopReason: 'max_tokens',
          usage: { inputTokens: 7, outputTokens: 1024, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }
      },
    }
    const bodies: unknown[] = []
    const core = fakeCore({
      async checkpoint(_j, _t, callId, body) {
        core.calls.push(`checkpoint:${callId}`)
        bodies.push(body)
        return { costed: true }
      },
    })
    const error = await runJob(
      { ...deps(core), model: stopped },
      { id: 'js', jobClass: 'interactive' },
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelStopped)
    expect((error as Error).name).toBe('ModelStopped')
    expect(core.calls).toEqual(['register:one', 'checkpoint:call-one'])
    expect(bodies).toEqual([
      expect.objectContaining({
        step: 'one',
        stopped: true,
        output: null,
        providerMessageId: 'm-stop',
        usage: {
          inputTokens: 7,
          outputTokens: 1024,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          serverToolSearches: 0,
          serverToolFetches: 0,
        },
      }),
    ])
  })

  it('saves the stop reason in the checkpoint', async () => {
    const seen: unknown[] = []
    const core = fakeCore({
      async checkpoint(_j, _t, _c, body) {
        seen.push(body.output)
        return { costed: true }
      },
    })
    await runJob(deps(core), { id: 'jo', jobClass: 'interactive' })
    expect(seen[0]).toEqual({ text: 'reply to one', stopReason: 'end_turn' })
  })

  it('hashes a request with another output schema differently', async () => {
    const hashes: string[] = []
    const core = fakeCore({
      async registerModelCall(_j, _t, input) {
        hashes.push(input.requestHash)
        return { outcome: 'use_checkpoint', output: { text: 'x' } }
      },
    })
    const run = (outputSchema?: Record<string, unknown>) =>
      runJob(
        {
          ...deps(core),
          handlers: {
            'test.echo': plain(async (ctx) => {
              await ctx.modelStep('s', {
                model: 'm',
                ...(outputSchema ? { outputSchema } : {}),
                messages: [{ role: 'user', content: 'hi' }],
                maxTokens: 10,
              })
              return { type: 'test.echo', result: null }
            }),
          },
        },
        { id: 'jx', jobClass: 'interactive' },
      )
    await run()
    await run({ type: 'object' })
    await run({ type: 'object' })
    await run({ type: 'array' })
    expect(hashes[1]).toBe(hashes[2])
    expect(hashes[0]).not.toBe(hashes[1])
    expect(hashes[3]).not.toBe(hashes[1])
  })

  const toolsRequest = (maxUses: number): ModelRequest => ({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 10,
    tools: [{ type: 'web_search_20260209', maxUses }],
  })
  const runOne = (core: CoreClient, modelClient: ModelClient, request: ModelRequest, out: unknown[]) =>
    runJob(
      {
        ...deps(core),
        model: modelClient,
        handlers: {
          'test.echo': plain(async (ctx) => {
            out.push(await ctx.modelStep('s', request))
            return { type: 'test.echo', result: null }
          }),
        },
      },
      { id: 'jt', jobClass: 'production' },
    )

  it('pause_turn is checkpointed as a reply, not a stop', async () => {
    const blocks = [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }]
    const paused: ModelClient = {
      async send() {
        return {
          text: 'part',
          content: blocks,
          messageId: 'm1',
          requestId: 'r1',
          stopReason: 'pause_turn',
          usage: {
            inputTokens: 5,
            outputTokens: 6,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            serverToolSearches: 2,
            serverToolFetches: 0,
          },
        }
      },
    }
    const bodies: Record<string, unknown>[] = []
    const core = fakeCore({
      async checkpoint(_j, _t, _c, body) {
        bodies.push(body as unknown as Record<string, unknown>)
        return { costed: true }
      },
    })
    const out: unknown[] = []
    await runOne(core, paused, toolsRequest(5), out)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.stopped).toBeUndefined()
    expect(JSON.parse(bodies[0]!.output as string)).toEqual({
      text: 'part',
      content: blocks,
      stopReason: 'pause_turn',
      serverToolSearches: 2,
      serverToolFetches: 0,
    })
    // R1 (task 4): the live counts go to the core, which costs the searches.
    expect(bodies[0]!.usage).toEqual({
      inputTokens: 5,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      serverToolSearches: 2,
      serverToolFetches: 0,
    })
    expect(out[0]).toMatchObject({
      text: 'part',
      stopReason: 'pause_turn',
      content: blocks,
      usage: { serverToolSearches: 2, serverToolFetches: 0 },
    })
  })

  it('replays a saved pause_turn step with its content and counts', async () => {
    const blocks = [
      { type: 'server_tool_use', name: 'web_search' },
      { type: 'server_tool_use', name: 'web_fetch' },
    ]
    const core = fakeCore({
      async registerModelCall() {
        return {
          outcome: 'use_checkpoint',
          output: JSON.stringify({ text: 'p', content: blocks, stopReason: 'pause_turn' }),
        }
      },
    })
    const out: unknown[] = []
    await runOne(core, model, toolsRequest(5), out)
    expect(out[0]).toMatchObject({
      text: 'p',
      stopReason: 'pause_turn',
      content: blocks,
      usage: { inputTokens: 0, serverToolSearches: 1, serverToolFetches: 1 },
    })
  })

  it('sends the timeout of the job class', async () => {
    const out: unknown[] = []
    const sent: ModelRequest[] = []
    const spy: ModelClient = {
      async send(request) {
        sent.push(request)
        return { ...(await model.send(request)), content: [] }
      },
    }
    const asClass = (jobClass: 'interactive' | 'production') =>
      fakeCore({
        async startAttempt() {
          return { ...(await fakeCore().startAttempt('j', 'w')), jobClass } as never
        },
      })
    await runOne(asClass('production'), spy, toolsRequest(1), out)
    await runOne(asClass('interactive'), spy, toolsRequest(1), out)
    expect(sent.map((r) => r.timeoutMs)).toEqual([900_000, 240_000])
  })

  it('requestHash changes when tools change', async () => {
    const hashes: string[] = []
    const core = fakeCore({
      async registerModelCall(_j, _t, input) {
        hashes.push(input.requestHash)
        return { outcome: 'use_checkpoint', output: { text: 'x' } }
      },
    })
    const out: unknown[] = []
    const plainRequest: ModelRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 10,
    }
    await runOne(core, model, plainRequest, out)
    await runOne(core, model, toolsRequest(5), out)
    await runOne(core, model, toolsRequest(5), out)
    await runOne(core, model, toolsRequest(6), out)
    expect(hashes[1]).toBe(hashes[2])
    expect(hashes[0]).not.toBe(hashes[1])
    expect(hashes[3]).not.toBe(hashes[1])
  })

  it('replays the saved provider counts, not a count of blocks', async () => {
    const blocks = [
      { type: 'server_tool_use', name: 'web_search' },
      { type: 'server_tool_use', name: 'web_search' },
    ]
    const core = fakeCore({
      async registerModelCall() {
        return {
          outcome: 'use_checkpoint',
          output: JSON.stringify({
            text: 'p',
            content: blocks,
            stopReason: 'pause_turn',
            serverToolSearches: 1,
            serverToolFetches: 0,
          }),
        }
      },
    })
    const out: unknown[] = []
    await runOne(core, model, toolsRequest(5), out)
    expect(out[0]).toMatchObject({ usage: { serverToolSearches: 1, serverToolFetches: 0 } })
  })

  it('saves a tool step that ends its turn as a JSON string and replays text holding U+0000', async () => {
    const reply: ModelClient = {
      async send() {
        return {
          text: 'a\u0000b',
          content: [{ type: 'text', text: 'a\u0000b' }],
          messageId: 'm',
          requestId: null,
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }
      },
    }
    const saved: unknown[] = []
    const core = fakeCore({
      async checkpoint(_j, _t, _c, body) {
        saved.push(body.output)
        return { costed: true }
      },
    })
    const out: { text: string }[] = []
    await runOne(core, reply, toolsRequest(5), out)
    expect(typeof saved[0]).toBe('string')
    // The core refuses a U+0000 character; JSON text carries it escaped.
    expect((saved[0] as string).includes('\u0000')).toBe(false)
    const replay = fakeCore({
      async registerModelCall() {
        return { outcome: 'use_checkpoint', output: JSON.parse(JSON.stringify(saved[0])) }
      },
    })
    const again: { text: string }[] = []
    await runOne(replay, model, toolsRequest(5), again)
    expect(again[0]!.text).toBe('a\u0000b')
  })

  it('a tools reply without content is costed and then an error, never an empty assistant turn', async () => {
    const noContent: ModelClient = {
      async send() {
        return {
          text: 't',
          messageId: 'm',
          requestId: null,
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }
      },
    }
    const bodies: Record<string, unknown>[] = []
    const core = fakeCore({
      async checkpoint(_j, _t, _c, body) {
        bodies.push(body as unknown as Record<string, unknown>)
        return { costed: true }
      },
    })
    await expect(runOne(core, noContent, toolsRequest(5), [])).rejects.toThrow(/no content/)
    expect(bodies[0]).toMatchObject({ stopped: true, output: null })
  })

  it('replays every saved turn of a tool request after a failed attempt, with no new provider request', async () => {
    const saved = new Map<string, { hash: string; output: unknown }>()
    const hashes = new Map<string, string>()
    const outcomes: string[] = []
    const core = fakeCore({
      async registerModelCall(_j, _t, input) {
        const found = saved.get(input.step)
        if (found && found.hash === input.requestHash) {
          outcomes.push(`${input.step}:replay`)
          return { outcome: 'use_checkpoint', output: found.output }
        }
        outcomes.push(`${input.step}:send`)
        hashes.set(input.step, input.requestHash)
        return { outcome: 'send', callId: `c-${input.step}`, possibleDuplicate: false }
      },
      async checkpoint(_j, _t, _c, body) {
        saved.set(body.step, {
          hash: hashes.get(body.step)!,
          output: body.output === null ? null : JSON.parse(JSON.stringify(body.output)),
        })
        return { costed: true }
      },
    })
    const u = (searches: number) => ({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      serverToolSearches: searches,
      serverToolFetches: 0,
    })
    const reply = (stopReason: string, content: unknown[], searches: number) => ({
      text: 't',
      content,
      messageId: 'm',
      requestId: null,
      stopReason,
      usage: u(searches),
    })
    // Two search blocks, but the provider billed one (the other search errored).
    const searchBlocks = [
      { type: 'server_tool_use', name: 'web_search' },
      { type: 'server_tool_use', name: 'web_search' },
    ]
    const sent1: string[] = []
    const first: ModelClient = {
      async send() {
        sent1.push('x')
        if (sent1.length === 1) return reply('pause_turn', searchBlocks, 1)
        if (sent1.length === 2) return reply('pause_turn', [{ type: 'text', text: 'a' }], 0)
        throw new Error('boom')
      },
    }
    const run = (modelClient: ModelClient) =>
      runJob(
        {
          ...deps(core),
          model: modelClient,
          handlers: {
            'test.echo': plain(async (ctx) => {
              await modelTurns(ctx, 'dig', toolsRequest(10), {
                searches: 10,
                fetches: 5,
                maxContinuations: 6,
              })
              return { type: 'test.echo', result: null }
            }),
          },
        },
        { id: 'jr', jobClass: 'interactive' },
      )
    await expect(run(first)).rejects.toThrow('boom')
    expect(outcomes).toEqual(['dig#0:send', 'dig#1:send', 'dig#2:send'])

    const sent2: ModelRequest[] = []
    const second: ModelClient = {
      async send(request) {
        sent2.push(request)
        return reply('end_turn', [{ type: 'text', text: 'done' }], 0)
      },
    }
    await run(second)
    expect(outcomes.slice(3)).toEqual(['dig#0:replay', 'dig#1:replay', 'dig#2:send'])
    expect(sent2).toHaveLength(1)
  })
})
