import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { cancelJob, listDead, markDead, requeueJob, sweepModelCalls } from '../src/jobs/dead.ts'
import { createJob, createRun, postResult, startAttempt, type JobsDeps } from '../src/jobs/service.ts'
import { verifyAttemptToken } from '../src/jobs/token.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack } from './support.ts'

let stack: Stack
let jobs: JobsDeps
let brandA: string
let brandB: string
let definitionId: string
const ACTOR = '99999999-9999-4999-8999-999999999999'

async function makeJob(brandId: string): Promise<{ jobId: string; runId: string }> {
  let runId = ''
  const jobId = await withBrand(stack.appPool, brandId, async (client) => {
    runId = await createRun(client, brandId, {
      agent: 'test-agent',
      definitionVersionId: definitionId,
      startedByKind: 'system',
      startedById: null,
    })
    return createJob(client, jobs, brandId, {
      runId,
      jobClass: 'interactive',
      input: {},
      expectedResultType: 'test.echo',
    })
  })
  return { jobId, runId }
}
async function addJob(brandId: string, runId: string): Promise<string> {
  return withBrand(stack.appPool, brandId, (client) =>
    createJob(client, jobs, brandId, {
      runId,
      jobClass: 'interactive',
      input: {},
      expectedResultType: 'test.echo',
    }),
  )
}
async function finishAttempt(jobId: string): Promise<void> {
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
  jobs.results.set('test.echo', async () => ({ ok: true }))
  const answer = await postResult(jobs, check.claims, { type: 'test.echo', result: {} })
  expect(answer.status).toBe('applied')
}
// What the library does after the last retry: the job is failed, and a copy goes to the dead-letter queue.
const kill = (jobId: string) =>
  stack.db.admin.query(`update pgboss.job set state = 'failed' where id = $1`, [jobId])
const runState = async (runId: string) =>
  (await stack.db.admin.query('select state from app.run where id = $1', [runId])).rows[0].state

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  brandA = await addBrand(stack, 'dead-a')
  brandB = await addBrand(stack, 'dead-b')
  definitionId = await seedDefinition(stack.db)
})
afterAll(async () => {
  await stack?.close()
})

describe('dead jobs', () => {
  it('marks a job dead, fails its run, lists it for its own brand only, and audits it', async () => {
    const { jobId, runId } = await makeJob(brandA)
    await kill(jobId)
    await markDead(jobs, jobId)
    expect(await runState(runId)).toBe('failed')
    expect((await listDead(jobs, brandA)).map((j) => j.jobId)).toContain(jobId)
    expect((await listDead(jobs, brandB)).map((j) => j.jobId)).not.toContain(jobId)
    const audit = await stack.db.admin.query(
      `select actor_kind from audit.log where action = 'jobs.dead' and subject = $1`,
      [jobId],
    )
    expect(audit.rows[0].actor_kind).toBe('system')
  })

  it('requeues a dead job: the queue retries it, the list clears, the run runs again, the user is the actor', async () => {
    const { jobId, runId } = await makeJob(brandA)
    await kill(jobId)
    await markDead(jobs, jobId)
    await requeueJob(jobs, brandA, jobId, ACTOR)
    expect(await jobs.queue.state('interactive', jobId)).toBe('retry')
    expect((await listDead(jobs, brandA)).map((j) => j.jobId)).not.toContain(jobId)
    expect(await runState(runId)).toBe('running')
    const audit = await stack.db.admin.query(
      `select actor_id from audit.log where action = 'jobs.requeued' and subject = $1`,
      [jobId],
    )
    expect(audit.rows[0].actor_id).toBe(ACTOR)
  })

  it('cancels a dead job and ends its run', async () => {
    const { jobId, runId } = await makeJob(brandA)
    await kill(jobId)
    await markDead(jobs, jobId)
    await cancelJob(jobs, brandA, jobId, ACTOR)
    expect(await jobs.queue.state('interactive', jobId)).toBe('cancelled')
    expect(await runState(runId)).toBe('cancelled')
  })

  it('refuses to requeue or cancel a job that is not dead, or one in another brand', async () => {
    const { jobId } = await makeJob(brandA)
    await expect(requeueJob(jobs, brandA, jobId, ACTOR)).rejects.toMatchObject({
      status: 409,
      code: 'job_not_dead',
    })
    await kill(jobId)
    await markDead(jobs, jobId)
    await expect(requeueJob(jobs, brandB, jobId, ACTOR)).rejects.toMatchObject({ status: 404 })
    await expect(cancelJob(jobs, brandB, jobId, ACTOR)).rejects.toMatchObject({ status: 404 })
  })

  it('does not list a requeued job as dead once its next attempt starts', async () => {
    const { jobId, runId } = await makeJob(brandA)
    await kill(jobId)
    await markDead(jobs, jobId)
    // The queue retried it but the database was not cleared (the order in requeueJob makes this the failure case).
    await jobs.queue.requeue('interactive', jobId)
    await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
      jobId,
    ])
    const started = await startAttempt(jobs, jobId, 'w1')
    if (started.finished) throw new Error('unexpected')
    expect((await listDead(jobs, brandA)).map((j) => j.jobId)).not.toContain(jobId)
    // The requeue's database half never ran, so the run was still failed: the attempt starting revives it,
    // and the result then ends it as succeeded.
    expect(await runState(runId)).toBe('running')
    const check = verifyAttemptToken(
      jobs.attemptTokenSecret,
      started.token,
      Math.floor(jobs.now().getTime() / 1000),
    )
    if (!check.ok) throw new Error('token')
    jobs.results.set('test.echo', async () => ({ ok: true }))
    const answer = await postResult(jobs, check.claims, { type: 'test.echo', result: {} })
    expect(answer.status).toBe('applied')
    expect(await runState(runId)).toBe('succeeded')
  })

  it('keeps a run failed while a sibling job is dead, and ends it succeeded once both finish', async () => {
    const { jobId: j1, runId } = await makeJob(brandA)
    const j2 = await addJob(brandA, runId)
    await kill(j1)
    await markDead(jobs, j1)
    expect(await runState(runId)).toBe('failed')
    // J2 gets an attempt (a retry by the queue): it must not revive a run whose sibling is dead.
    await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
      j2,
    ])
    const started = await startAttempt(jobs, j2, 'w1')
    if (started.finished) throw new Error('unexpected')
    expect(await runState(runId)).toBe('failed')
    // Requeueing J1 while J2 is only started: nothing else is dead, so the run runs again.
    await requeueJob(jobs, brandA, j1, ACTOR)
    expect(await runState(runId)).toBe('running')
    await finishAttempt(j1)
    const check = verifyAttemptToken(
      jobs.attemptTokenSecret,
      started.token,
      Math.floor(jobs.now().getTime() / 1000),
    )
    if (!check.ok) throw new Error('token')
    jobs.results.set('test.echo', async () => ({ ok: true }))
    await postResult(jobs, check.claims, { type: 'test.echo', result: {} })
    expect(await runState(runId)).toBe('succeeded')
  })

  it('does not revive the run on a requeue while another job of it is still dead', async () => {
    const { jobId: j1, runId } = await makeJob(brandA)
    const j2 = await addJob(brandA, runId)
    await kill(j1)
    await markDead(jobs, j1)
    await kill(j2)
    await markDead(jobs, j2)
    await requeueJob(jobs, brandA, j1, ACTOR)
    expect(await runState(runId)).toBe('failed')
    await requeueJob(jobs, brandA, j2, ACTOR)
    expect(await runState(runId)).toBe('running')
  })

  it('finishes the database half of a cancel whose queue half already ran', async () => {
    const { jobId, runId } = await makeJob(brandA)
    await kill(jobId)
    await markDead(jobs, jobId)
    await stack.db.admin.query(`update pgboss.job set state = 'cancelled' where id = $1`, [jobId])
    await expect(requeueJob(jobs, brandA, jobId, ACTOR)).rejects.toMatchObject({ status: 409 })
    await cancelJob(jobs, brandA, jobId, ACTOR)
    expect((await listDead(jobs, brandA)).map((j) => j.jobId)).not.toContain(jobId)
    expect(await runState(runId)).toBe('cancelled')
  })

  it('ignores a dead-letter copy that arrives after the job was requeued', async () => {
    const { jobId, runId } = await makeJob(brandA)
    await kill(jobId)
    await markDead(jobs, jobId)
    await requeueJob(jobs, brandA, jobId, ACTOR)
    await markDead(jobs, jobId)
    expect(await runState(runId)).toBe('running')
    expect((await listDead(jobs, brandA)).map((j) => j.jobId)).not.toContain(jobId)
  })

  it('does not mark dead a job the queue does not show as failed', async () => {
    const { jobId, runId } = await makeJob(brandA)
    await markDead(jobs, jobId)
    expect(await runState(runId)).toBe('running')
    expect((await listDead(jobs, brandA)).map((j) => j.jobId)).not.toContain(jobId)
  })

  it('refuses a requeue or cancel when the queue no longer shows the job as failed', async () => {
    const { jobId } = await makeJob(brandA)
    await kill(jobId)
    await markDead(jobs, jobId)
    // A cancel whose database half rolled back: the queue says cancelled, the database still lists it.
    await stack.db.admin.query(`update pgboss.job set state = 'cancelled' where id = $1`, [jobId])
    await expect(requeueJob(jobs, brandA, jobId, ACTOR)).rejects.toMatchObject({
      status: 409,
      code: 'job_not_dead',
    })
    // A cancel is not refused: the queue half is already done and only the database half is finished.
    await expect(cancelJob(jobs, brandA, jobId, ACTOR)).resolves.toBeUndefined()
  })
})

describe('reconciliation', () => {
  it('marks started calls older than the class expiry unknown, per class, and leaves newer ones', async () => {
    const { jobId, runId } = await makeJob(brandA)
    await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
      jobId,
    ])
    const started = await startAttempt(jobs, jobId, 'w1')
    if (started.finished) throw new Error('unexpected')
    await withBrand(stack.appPool, brandA, (c) =>
      c.query(
        `insert into app.model_call (brand_id, run_id, job_id, attempt_id, step, request_hash, model, started_at)
         values ($1, $2, $3, $4, 'old', 'h1', 'm', now() - interval '10 minutes'),
                ($1, $2, $3, $4, 'new', 'h2', 'm', now() - interval '1 minute')`,
        [brandA, runId, jobId, started.attemptId],
      ),
    )
    // Interactive jobs expire after 5 minutes: the 10-minute-old call is past it, the 1-minute-old one is not.
    expect(await sweepModelCalls(jobs)).toBeGreaterThanOrEqual(1)
    const rows = await stack.db.admin.query(
      'select step, status from app.model_call where job_id = $1 order by step',
      [jobId],
    )
    expect(rows.rows).toEqual([
      { step: 'new', status: 'started' },
      { step: 'old', status: 'unknown' },
    ])
  })
})

describe('the job routes', () => {
  it('lets the platform owner list, requeue and cancel, refuses a brand admin, and hides the brand from a stranger', async () => {
    const PASSWORD = 'correct horse battery'
    await addUser(stack, { email: 'owner@dead.test', password: PASSWORD, platformOwner: true })
    await addUser(stack, {
      email: 'admin@dead.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brandA,
    })
    await addUser(stack, {
      email: 'stranger@dead.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brandB,
    })
    const owner = (await enrolledClient(stack, 'owner@dead.test', PASSWORD)).client
    const admin = (await enrolledClient(stack, 'admin@dead.test', PASSWORD)).client
    const stranger = (await enrolledClient(stack, 'stranger@dead.test', PASSWORD)).client
    const { jobId } = await makeJob(brandA)
    await kill(jobId)
    await markDead(jobs, jobId)

    const list = await owner.request('GET', `/api/v1/brands/${brandA}/jobs/dead`)
    expect(list.status).toBe(200)
    expect(list.json.map((j: { jobId: string }) => j.jobId)).toContain(jobId)

    expect((await admin.request('GET', `/api/v1/brands/${brandA}/jobs/dead`)).status).toBe(403)
    expect((await stranger.request('GET', `/api/v1/brands/${brandA}/jobs/dead`)).status).toBe(404)
    expect((await admin.request('POST', `/api/v1/brands/${brandA}/jobs/${jobId}/requeue`)).status).toBe(403)
    expect((await admin.request('POST', `/api/v1/brands/${brandA}/jobs/${jobId}/cancel`)).status).toBe(403)
    // Brand A's job under brand B's path is not found, even for the platform owner.
    expect((await owner.request('POST', `/api/v1/brands/${brandB}/jobs/${jobId}/requeue`)).status).toBe(404)
    expect((await owner.request('POST', `/api/v1/brands/${brandB}/jobs/${jobId}/cancel`)).status).toBe(404)

    expect((await owner.request('POST', `/api/v1/brands/${brandA}/jobs/${jobId}/requeue`)).status).toBe(204)
    expect((await owner.request('POST', `/api/v1/brands/${brandA}/jobs/${jobId}/requeue`)).status).toBe(409)
  })

  it('answers the worker reports only to the worker credential', async () => {
    const { jobId, runId } = await makeJob(brandA)
    await kill(jobId)
    const url = `${stack.server.url}/api/v1/worker/jobs/${jobId}/dead`
    const refused = await fetch(url, { method: 'POST', headers: { authorization: 'Worker wrong' } })
    expect(refused.status).toBe(401)
    const headers = { authorization: `Worker ${jobs.workerSecret}`, 'content-type': 'application/json' }
    const dead = await fetch(url, { method: 'POST', headers, body: '{}' })
    expect(dead.status).toBe(204)
    expect(await runState(runId)).toBe('failed')
    const swept = await fetch(`${stack.server.url}/api/v1/worker/reconcile`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    expect(swept.status).toBe(200)
    expect(await swept.json()).toEqual({ marked: expect.any(Number) })
  })

  it('answers which failed jobs the core has not marked dead, to the worker credential only', async () => {
    const unmarked = await makeJob(brandA)
    const marked = await makeJob(brandA)
    await kill(marked.jobId)
    await markDead(jobs, marked.jobId)
    const stranger = '11111111-1111-4111-8111-111111111111'
    const url = `${stack.server.url}/api/v1/worker/dead/unmarked`
    const body = JSON.stringify({ jobIds: [unmarked.jobId, marked.jobId, stranger] })
    const none = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Worker wrong', 'content-type': 'application/json' },
      body,
    })
    expect(none.status).toBe(401)
    const headers = { authorization: `Worker ${jobs.workerSecret}`, 'content-type': 'application/json' }
    const reply = await fetch(url, { method: 'POST', headers, body })
    expect(reply.status).toBe(200)
    expect(await reply.json()).toEqual({ jobIds: [unmarked.jobId] })
    const bad = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jobIds: ['x'] }) })
    expect(bad.status).toBe(400)
  })
})
