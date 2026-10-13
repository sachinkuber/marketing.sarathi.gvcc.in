import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import type { JobsDeps } from '../src/jobs/service.ts'
import { createJob, createRun, postResult, startAttempt } from '../src/jobs/service.ts'
import type { ResultHandler } from '../src/jobs/results.ts'
import { verifyAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'
import { addBrand, createStack, type Stack } from './support.ts'

let stack: Stack
let jobs: JobsDeps
let brand: string
let definitionId: string
let applied = 0

// A result type for the tests: counts how many times a result is applied and returns a small outcome.
const echo: ResultHandler = async (_client, ctx) => {
  applied += 1
  return { echoed: ctx.result, jobId: ctx.jobId }
}

async function startedJob(): Promise<{
  jobId: string
  runId: string
  claims: AttemptClaims
  token: string
}> {
  let runId = ''
  const jobId = await withBrand(stack.appPool, brand, async (client) => {
    runId = await createRun(client, brand, {
      agent: 'test-agent',
      definitionVersionId: definitionId,
      startedByKind: 'system',
      startedById: null,
    })
    return createJob(client, jobs, brand, {
      runId,
      jobClass: 'interactive',
      input: {},
      expectedResultType: 'test.echo',
    })
  })
  await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
    jobId,
  ])
  const started = await startAttempt(jobs, jobId, 'w1')
  if (started.finished) throw new Error('unexpected')
  const check = verifyAttemptToken(
    jobs.attemptTokenSecret,
    started.token,
    Math.floor(jobs.now().getTime() / 1000),
  )
  if (!check.ok) throw new Error('token')
  return { jobId, runId, claims: check.claims, token: started.token }
}

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('the stack has no queue')
  jobs = stack.jobs
  brand = await addBrand(stack, 'results')
  definitionId = await seedDefinition(stack.db)
})
// Every test starts from the same handler, whatever an earlier test replaced or removed.
afterEach(() => {
  jobs.results.set('test.echo', echo)
})
afterAll(async () => {
  await stack?.close()
})

// The hash is over canonical JSON (keys sorted at every depth), so the expectation is written sorted.
const sha = (value: unknown): string =>
  'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex')

describe('posting a result', () => {
  it('applies a result once, stores its hash and outcome, and finishes the job and the run', async () => {
    jobs.results.set('test.echo', echo)
    const before = applied
    const { jobId, runId, claims } = await startedJob()
    const answer = await postResult(jobs, claims, { type: 'test.echo', result: { text: 'hi' } })
    expect(answer).toMatchObject({ status: 'applied', outcome: { echoed: { text: 'hi' }, jobId } })
    expect(applied).toBe(before + 1)
    const job = await stack.db.admin.query(
      'select result_type, result_hash, finished_at from app.job_input where job_id = $1',
      [jobId],
    )
    expect(job.rows[0].result_type).toBe('test.echo')
    expect(job.rows[0].result_hash).toBe(sha({ result: { text: 'hi' }, type: 'test.echo' }))
    expect(job.rows[0].finished_at).not.toBeNull()
    const run = await stack.db.admin.query('select state, finished_at from app.run where id = $1', [runId])
    expect(run.rows[0].state).toBe('succeeded')
  })

  it('test 27: the same result again returns the first outcome and applies nothing', async () => {
    jobs.results.set('test.echo', echo)
    const { claims } = await startedJob()
    const first = await postResult(jobs, claims, { type: 'test.echo', result: { n: 1 } })
    const before = applied
    const second = await postResult(jobs, claims, { type: 'test.echo', result: { n: 1 } })
    expect(second).toEqual({ status: 'repeated', outcome: (first as { outcome: unknown }).outcome })
    expect(applied).toBe(before)
  })

  it('the same result with its keys in another order is a repeat, not a conflict', async () => {
    jobs.results.set('test.echo', echo)
    const { claims } = await startedJob()
    const first = await postResult(jobs, claims, {
      type: 'test.echo',
      result: { b: 1, a: { y: [1, { d: 4, c: 3 }], x: 'k' } },
    })
    const before = applied
    const second = await postResult(jobs, claims, {
      type: 'test.echo',
      result: { a: { x: 'k', y: [1, { c: 3, d: 4 }] }, b: 1 },
    })
    expect(second).toEqual({ status: 'repeated', outcome: (first as { outcome: unknown }).outcome })
    expect(applied).toBe(before)
  })

  it('test 27: a different result for a finished job is refused', async () => {
    jobs.results.set('test.echo', echo)
    const { claims } = await startedJob()
    await postResult(jobs, claims, { type: 'test.echo', result: { n: 1 } })
    const before = applied
    await expect(postResult(jobs, claims, { type: 'test.echo', result: { n: 2 } })).rejects.toMatchObject({
      status: 409,
      code: 'result_differs',
    })
    expect(applied).toBe(before)
  })

  it('refuses a result of a type other than the token allows, and a type with no handler', async () => {
    const { claims } = await startedJob()
    await expect(postResult(jobs, claims, { type: 'something.else', result: {} })).rejects.toMatchObject({
      status: 422,
      code: 'wrong_result_type',
    })
    jobs.results.delete('test.echo')
    await expect(postResult(jobs, claims, { type: 'test.echo', result: {} })).rejects.toMatchObject({
      status: 422,
      code: 'no_result_handler',
    })
  })

  it("test 26: a result from an attempt that lost its lease is refused and recorded, and the new attempt's result is applied", async () => {
    jobs.results.set('test.echo', echo)
    const { jobId, claims: old } = await startedJob()
    const started = await startAttempt(jobs, jobId, 'w2')
    if (started.finished) throw new Error('unexpected')
    const check = verifyAttemptToken(
      jobs.attemptTokenSecret,
      started.token,
      Math.floor(jobs.now().getTime() / 1000),
    )
    if (!check.ok) throw new Error('token')

    await expect(postResult(jobs, old, { type: 'test.echo', result: { from: 'old' } })).rejects.toMatchObject(
      {
        status: 403,
        code: 'attempt_refused',
      },
    )
    const logged = await stack.db.admin.query(
      `select detail from audit.log where action = 'worker.attempt_refused' and detail->>'jobId' = $1`,
      [jobId],
    )
    expect(logged.rowCount).toBeGreaterThanOrEqual(1)

    const answer = await postResult(jobs, check.claims, { type: 'test.echo', result: { from: 'new' } })
    expect(answer).toMatchObject({ status: 'applied', outcome: { echoed: { from: 'new' } } })
  })

  it('stores a result posted while the job is held, applies nothing, and leaves the job unfinished', async () => {
    jobs.results.set('test.echo', echo)
    const { jobId, claims } = await startedJob()
    await stack.db.admin.query('update app.job_control set held = true where job_id = $1', [jobId])
    const before = applied
    expect(await postResult(jobs, claims, { type: 'test.echo', result: { held: true } })).toEqual({
      status: 'held',
    })
    expect(applied).toBe(before)
    const job = await stack.db.admin.query(
      'select held_result, finished_at from app.job_input where job_id = $1',
      [jobId],
    )
    expect(job.rows[0]).toMatchObject({
      held_result: { type: 'test.echo', result: { held: true } },
      finished_at: null,
    })
  })

  it('refuses a result for a job whose cancel was requested', async () => {
    jobs.results.set('test.echo', echo)
    const { jobId, claims } = await startedJob()
    await stack.db.admin.query('update app.job_control set cancel_requested = true where job_id = $1', [
      jobId,
    ])
    await expect(postResult(jobs, claims, { type: 'test.echo', result: {} })).rejects.toMatchObject({
      status: 409,
      code: 'job_cancelled',
    })
  })

  it('rolls the whole result back when the handler throws', async () => {
    const { jobId, claims } = await startedJob()
    jobs.results.set('test.echo', async () => {
      throw new Error('handler failed')
    })
    await expect(postResult(jobs, claims, { type: 'test.echo', result: {} })).rejects.toThrow(
      'handler failed',
    )
    const job = await stack.db.admin.query(
      'select result_hash, finished_at from app.job_input where job_id = $1',
      [jobId],
    )
    expect(job.rows[0]).toEqual({ result_hash: null, finished_at: null })
    const attempt = await stack.db.admin.query('select state from app.job_attempt where job_id = $1', [jobId])
    expect(attempt.rows[0].state).toBe('active')
  })
})

describe('the result route', () => {
  async function post(jobId: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${stack.server.url}/api/v1/worker/jobs/${jobId}/result`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Worker ${jobs.workerSecret}`,
        'x-attempt-token': token,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  it('answers 200 for applied and repeated, and 202 for a held result', async () => {
    jobs.results.set('test.echo', echo)
    const a = await startedJob()
    const applied1 = await post(a.jobId, a.token, { type: 'test.echo', result: { n: 1 } })
    expect(applied1.status).toBe(200)
    expect(await applied1.json()).toMatchObject({ status: 'applied' })
    const repeated = await post(a.jobId, a.token, { type: 'test.echo', result: { n: 1 } })
    expect(repeated.status).toBe(200)
    expect(await repeated.json()).toMatchObject({ status: 'repeated' })
    const differs = await post(a.jobId, a.token, { type: 'test.echo', result: { n: 2 } })
    expect(differs.status).toBe(409)

    const h = await startedJob()
    await stack.db.admin.query('update app.job_control set held = true where job_id = $1', [h.jobId])
    const held = await post(h.jobId, h.token, { type: 'test.echo', result: { n: 1 } })
    expect(held.status).toBe(202)
    expect(await held.json()).toEqual({ status: 'held' })
  })

  it('rejects a malformed body, U+0000 in a string, and a body over 100 kB', async () => {
    const { jobId, token } = await startedJob()
    expect((await post(jobId, token, { type: '', result: {} })).status).toBe(400)
    expect((await post(jobId, token, { type: 'test.echo' })).status).toBe(400)
    expect((await post(jobId, token, { type: 'test.echo', result: {}, extra: 1 })).status).toBe(400)
    expect((await post(jobId, token, { type: 'test.echo', result: { t: 'a\u0000b' } })).status).toBe(400)
    expect((await post(jobId, token, { type: 'test.echo', result: { t: 'x'.repeat(200_000) } })).status).toBe(
      413,
    )
  })

  it('answers 500 without the handler message when the handler throws', async () => {
    const { jobId, token } = await startedJob()
    jobs.results.set('test.echo', async () => {
      throw new Error('secret handler detail')
    })
    const res = await post(jobId, token, { type: 'test.echo', result: {} })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret handler detail')
  })
})
