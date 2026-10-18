import { createHash, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { AppError } from '../src/errors.ts'
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

async function startedJob(existingRunId?: string): Promise<{
  jobId: string
  runId: string
  claims: AttemptClaims
  token: string
}> {
  let runId = existingRunId ?? ''
  const jobId = await withBrand(stack.appPool, brand, async (client) => {
    if (!existingRunId) {
      runId = await createRun(client, brand, {
        agent: 'test-agent',
        definitionVersionId: definitionId,
        startedByKind: 'system',
        startedById: null,
      })
    }
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
  if (started.finished || 'outcome' in started) throw new Error('unexpected')
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
    if (started.finished || 'outcome' in started) throw new Error('unexpected')
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

describe("a run's state", () => {
  const runRow = async (runId: string) =>
    (await stack.db.admin.query('select state, finished_at from app.run where id = $1', [runId])).rows[0]

  it('stays unfinished after the first of two jobs and succeeds after the second', async () => {
    jobs.results.set('test.echo', echo)
    const a = await startedJob()
    const b = await startedJob(a.runId)
    await postResult(jobs, a.claims, { type: 'test.echo', result: { n: 1 } })
    const mid = await runRow(a.runId)
    expect(mid.state).not.toBe('succeeded')
    expect(mid.finished_at).toBeNull()
    await postResult(jobs, b.claims, { type: 'test.echo', result: { n: 2 } })
    const end = await runRow(a.runId)
    expect(end.state).toBe('succeeded')
    expect(end.finished_at).not.toBeNull()
  })

  it('succeeds when the last two jobs of a run finish at the same moment', async () => {
    jobs.results.set('test.echo', echo)
    for (let round = 0; round < 5; round += 1) {
      const a = await startedJob()
      const b = await startedJob(a.runId)
      const both = await Promise.all([
        postResult(jobs, a.claims, { type: 'test.echo', result: { round, who: 'a' } }),
        postResult(jobs, b.claims, { type: 'test.echo', result: { round, who: 'b' } }),
      ])
      expect(both.map((r) => r.status)).toEqual(['applied', 'applied'])
      const end = await runRow(a.runId)
      expect(end.state).toBe('succeeded')
      expect(end.finished_at).not.toBeNull()
    }
  })

  // Deterministic: the run row is held by the test, so both posts park on it; once both are parked the
  // test lets go. Without the run lock both would evaluate "no unfinished sibling" on their own snapshot
  // and the run would never be marked succeeded.
  it('succeeds when two sibling jobs are parked at the run and released together', async () => {
    jobs.results.set('test.echo', echo)
    const a = await startedJob()
    const b = await startedJob(a.runId)
    const holder = await stack.db.admin.connect()
    let released = false
    try {
      await holder.query('begin')
      await holder.query('select 1 from app.run where id = $1 for update', [a.runId])
      const pid = (await holder.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      const posts = Promise.all([
        postResult(jobs, a.claims, { type: 'test.echo', result: { who: 'a' } }),
        postResult(jobs, b.claims, { type: 'test.echo', result: { who: 'b' } }),
      ])
      const deadline = Date.now() + 10_000
      for (;;) {
        const waiting = await stack.db.admin.query(
          // Row-lock waiters queue behind one another, so the second may be blocked by the first waiter, not by
          // the holder: count every backend of this database that waits on a lock, other than the holder.
          `select count(*)::int as n from pg_stat_activity
            where wait_event_type = 'Lock' and datname = current_database() and pid <> $1`,
          [pid],
        )
        if (waiting.rows[0].n >= 2) break
        if (Date.now() > deadline) throw new Error('both posts never parked at the run row')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await holder.query('commit')
      released = true
      const both = await posts
      expect(both.map((r) => r.status)).toEqual(['applied', 'applied'])
      const end = await runRow(a.runId)
      expect(end.state).toBe('succeeded')
      expect(end.finished_at).not.toBeNull()
    } finally {
      if (!released) await holder.query('rollback').catch(() => undefined)
      holder.release()
    }
  })

  it('does not deadlock when the handlers write rows that reference the run', async () => {
    const a = await startedJob()
    const b = await startedJob(a.runId)
    // A handler row with a foreign key to the run takes a shared lock on the run row.
    jobs.results.set('test.echo', async (client, ctx) => {
      await client.query(
        `insert into app.job_input (job_id, brand_id, run_id, class, input, expected_result_type, finished_at)
         values ($1, $2, $3, 'interactive', '{}'::jsonb, 'test.echo', now())`,
        [randomUUID(), ctx.brandId, ctx.runId],
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { ok: true }
    })
    for (let round = 0; round < 3; round += 1) {
      const x = round === 0 ? a : await startedJob(a.runId)
      const y = round === 0 ? b : await startedJob(a.runId)
      const both = await Promise.all([
        postResult(jobs, x.claims, { type: 'test.echo', result: { round, who: 'x' } }),
        postResult(jobs, y.claims, { type: 'test.echo', result: { round, who: 'y' } }),
      ])
      expect(both.map((r) => r.status)).toEqual(['applied', 'applied'])
    }
    expect((await runRow(a.runId)).state).toBe('succeeded')
  })

  it('leaves a cancelled run cancelled when its last job result is accepted', async () => {
    jobs.results.set('test.echo', echo)
    const a = await startedJob()
    await stack.db.admin.query(
      `update app.run set state = 'cancelled', finished_at = '2020-01-01T00:00:00Z' where id = $1`,
      [a.runId],
    )
    expect(await postResult(jobs, a.claims, { type: 'test.echo', result: {} })).toMatchObject({
      status: 'applied',
    })
    const end = await runRow(a.runId)
    expect(end.state).toBe('cancelled')
    expect(new Date(end.finished_at).toISOString()).toBe('2020-01-01T00:00:00.000Z')
  })

  it('applies exactly one of two simultaneous different results for one job', async () => {
    jobs.results.set('test.echo', echo)
    const { jobId, claims } = await startedJob()
    const before = applied
    const settled = await Promise.allSettled([
      postResult(jobs, claims, { type: 'test.echo', result: { v: 1 } }),
      postResult(jobs, claims, { type: 'test.echo', result: { v: 2 } }),
    ])
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ status: 409, code: 'result_differs' })
    expect(applied).toBe(before + 1)
    const row = await stack.db.admin.query('select outcome from app.job_input where job_id = $1', [jobId])
    expect(row.rows[0].outcome).toMatchObject({ jobId })
  })

  it('applies one of two simultaneous equal results and repeats the other', async () => {
    jobs.results.set('test.echo', echo)
    const { claims } = await startedJob()
    const before = applied
    const both = await Promise.all([
      postResult(jobs, claims, { type: 'test.echo', result: { same: true } }),
      postResult(jobs, claims, { type: 'test.echo', result: { same: true } }),
    ])
    expect(both.map((r) => r.status).sort()).toEqual(['applied', 'repeated'])
    expect(applied).toBe(before + 1)
    expect(both[0]).toEqual({ ...both[1], status: both[0].status })
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

  it('passes an AppError thrown by a handler through with its status', async () => {
    const { jobId, token } = await startedJob()
    jobs.results.set('test.echo', async () => {
      throw new AppError(422, 'bad_content', 'The content is not acceptable.')
    })
    const res = await post(jobId, token, { type: 'test.echo', result: {} })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: { code: 'bad_content' } })
    const row = await stack.db.admin.query('select finished_at from app.job_input where job_id = $1', [jobId])
    expect(row.rows[0].finished_at).toBeNull()
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
