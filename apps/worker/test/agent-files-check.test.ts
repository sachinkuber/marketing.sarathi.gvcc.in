import { describe, expect, it } from 'vitest'
import type { CoreClient } from '../src/core-client.ts'
import type { ModelClient } from '../src/model.ts'
import { runJob, type JobHandler } from '../src/runner.ts'

const HASH = 'a'.repeat(64)

function core(started: { agent: string | null; filesHash: string | null }) {
  const dead: Array<{ jobId: string; reason: string | undefined }> = []
  const posted: unknown[] = []
  const client = {
    async startAttempt() {
      return {
        finished: false,
        attemptId: 'a',
        attemptNumber: 1,
        token: 'tok',
        input: {},
        savedSteps: [],
        expectedResultType: 'test.echo',
        jobClass: 'interactive',
        ...started,
      }
    },
    async control() {
      return { cancelRequested: false, held: false }
    },
    async postResult(_j: string, _t: string, p: unknown) {
      posted.push(p)
      return { status: 'applied' }
    },
    async jobDead(jobId: string, reason?: string) {
      dead.push({ jobId, reason })
    },
  } as unknown as CoreClient
  return { client, dead, posted }
}

const sent: unknown[] = []
const model: ModelClient = {
  async send(request) {
    sent.push(request)
    throw new Error('no model call expected')
  },
}

function deps(c: CoreClient, entry: { agent: string | null; filesHash: string | null }) {
  let ran = 0
  const handler: JobHandler = async () => {
    ran += 1
    return { type: 'test.echo', result: {} }
  }
  return {
    deps: { core: c, model, handlers: { 'test.echo': { handler, ...entry } }, workerId: 'w' },
    ran: () => ran,
  }
}

describe('the worker runs only the released agent files', () => {
  it('a job whose files hash differs is marked dead without a model call', async () => {
    const c = core({ agent: 'summary', filesHash: 'b'.repeat(64) })
    const d = deps(c.client, { agent: 'summary', filesHash: HASH })
    await expect(runJob(d.deps, { id: 'j1', jobClass: 'interactive' })).rejects.toThrow(
      /agent_files_mismatch/,
    )
    expect(c.dead).toEqual([{ jobId: 'j1', reason: 'agent_files_mismatch' }])
    expect(d.ran()).toBe(0)
    expect(sent).toHaveLength(0)
    expect(c.posted).toHaveLength(0)
  })

  it('a job for a different agent is marked dead', async () => {
    const c = core({ agent: 'other', filesHash: HASH })
    const d = deps(c.client, { agent: 'summary', filesHash: HASH })
    await expect(runJob(d.deps, { id: 'j2', jobClass: 'interactive' })).rejects.toThrow()
    expect(c.dead).toHaveLength(1)
    expect(d.ran()).toBe(0)
  })

  it('an old job with no agent is refused when the handler names an agent', async () => {
    const c = core({ agent: null, filesHash: null })
    const d = deps(c.client, { agent: 'summary', filesHash: HASH })
    await expect(runJob(d.deps, { id: 'j3', jobClass: 'interactive' })).rejects.toThrow()
    expect(d.ran()).toBe(0)
  })

  it('a matching job runs', async () => {
    const c = core({ agent: 'summary', filesHash: HASH })
    const d = deps(c.client, { agent: 'summary', filesHash: HASH })
    await runJob(d.deps, { id: 'j4', jobClass: 'interactive' })
    expect(d.ran()).toBe(1)
    expect(c.dead).toHaveLength(0)
    expect(c.posted).toHaveLength(1)
  })

  it('a handler that names no agent runs whatever the job carries', async () => {
    const none = core({ agent: null, filesHash: null })
    const a = deps(none.client, { agent: null, filesHash: null })
    await runJob(a.deps, { id: 'j5', jobClass: 'interactive' })
    expect(a.ran()).toBe(1)
    const some = core({ agent: 'summary', filesHash: HASH })
    const b = deps(some.client, { agent: null, filesHash: null })
    await runJob(b.deps, { id: 'j6', jobClass: 'interactive' })
    expect(b.ran()).toBe(1)
  })
})
