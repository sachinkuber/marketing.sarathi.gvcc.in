import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cancelJob, markDead, requeueJob } from '../src/jobs/dead.ts'
import { createJob, createRun, postResult, startAttempt, type JobsDeps } from '../src/jobs/service.ts'
import { verifyAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'
import { addBrand, createStack, type Stack } from './support.ts'

// How a run ends when it has several jobs (plan decision 15, milestone 4 parked ruling 11).

let stack: Stack
let jobs: JobsDeps
let brand: string
let definitionId: string
const ACTOR = '99999999-9999-4999-8999-999999999999'

const newRun = (): Promise<string> =>
  withBrand(stack.appPool, brand, (client) =>
    createRun(client, brand, {
      agent: 'test-agent',
      definitionVersionId: definitionId,
      startedByKind: 'system',
      startedById: null,
    }),
  )
const addJob = (runId: string): Promise<string> =>
  withBrand(stack.appPool, brand, (client) =>
    createJob(client, jobs, brand, { runId, jobClass: 'interactive', input: {}, expectedResultType: 'test.echo' }),
  )
const kill = async (jobId: string) => {
  await stack.db.admin.query(`update pgboss.job set state = 'failed' where id = $1`, [jobId])
  await markDead(jobs, jobId)
}
async function claim(jobId: string): Promise<AttemptClaims> {
  await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [jobId])
  const started = await startAttempt(jobs, jobId, 'w1')
  if (started.finished || 'outcome' in started) throw new Error('unexpected')
  const check = verifyAttemptToken(jobs.attemptTokenSecret, started.token, Math.floor(jobs.now().getTime() / 1000))
  if (!check.ok) throw new Error('token')
  return check.claims
}
const finish = async (claims: AttemptClaims) =>
  expect((await postResult(jobs, claims, { type: 'test.echo', result: {} })).status).toBe('applied')
const state = async (runId: string) =>
  (await stack.db.admin.query('select state, finished_at from app.run where id = $1', [runId])).rows[0]

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  jobs.results.set('test.echo', async () => ({ ok: true }))
  brand = await addBrand(stack, 'fin-a')
  definitionId = await seedDefinition(stack.db)
}, 120_000)
afterAll(async () => {
  await stack?.close()
})

describe('finaliseRun', () => {
  it('ruling 11: job 1 dead, job 2 retried, job 1 cancelled, job 2 finishes: the run ends succeeded', async () => {
    const runId = await newRun()
    const j1 = await addJob(runId)
    const j2 = await addJob(runId)
    await kill(j1)
    expect((await state(runId)).state).toBe('failed')
    // Job 2 is retried and has an attempt, while job 1 is still dead: the run stays failed.
    const claims2 = await claim(j2)
    expect((await state(runId)).state).toBe('failed')
    await cancelJob(jobs, brand, j1, ACTOR)
    // Nothing is dead any more and job 2 is still going: the run runs again.
    expect((await state(runId)).state).toBe('running')
    await finish(claims2)
    const end = await state(runId)
    expect(end.state).toBe('succeeded')
    expect(end.finished_at).not.toBeNull()
  })

  it('cancelling the only dead job of a run with no finished job ends the run cancelled', async () => {
    const runId = await newRun()
    const j1 = await addJob(runId)
    await kill(j1)
    await cancelJob(jobs, brand, j1, ACTOR)
    expect((await state(runId)).state).toBe('cancelled')
  })

  it('a run with one finished job and one cancelled job is succeeded, whichever came last', async () => {
    const runId = await newRun()
    const j1 = await addJob(runId)
    const j2 = await addJob(runId)
    const claims1 = await claim(j1)
    await finish(claims1)
    expect((await state(runId)).state).toBe('running')
    await kill(j2)
    expect((await state(runId)).state).toBe('failed')
    await cancelJob(jobs, brand, j2, ACTOR)
    expect((await state(runId)).state).toBe('succeeded')
  })

  it('never succeeds while a job is dead, even when every other job has finished', async () => {
    const runId = await newRun()
    const j1 = await addJob(runId)
    const j2 = await addJob(runId)
    await kill(j1)
    const claims2 = await claim(j2)
    await finish(claims2)
    expect((await state(runId)).state).toBe('failed')
    await requeueJob(jobs, brand, j1, ACTOR)
    expect((await state(runId)).state).toBe('running')
    await finish(await claim(j1))
    expect((await state(runId)).state).toBe('succeeded')
  })

  it('leaves a cancelled run cancelled when a job finishes later', async () => {
    const runId = await newRun()
    const j1 = await addJob(runId)
    const claims = await claim(j1)
    await stack.db.admin.query(`update app.run set state = 'cancelled', finished_at = now() where id = $1`, [runId])
    await finish(claims)
    expect((await state(runId)).state).toBe('cancelled')
  })
})
