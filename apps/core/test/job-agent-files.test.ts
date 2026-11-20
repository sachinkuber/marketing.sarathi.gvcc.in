import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { createJob, createRun, startAttempt, type JobsDeps } from '../src/jobs/service.ts'
import { AppError } from '../src/errors.ts'
import { markDead } from '../src/jobs/dead.ts'
import { startRun } from './summary-support.ts'
import { addBrand, addUser, createStack, type Stack } from './support.ts'

const SUMMARY_FILES_HASH = 'dcd031ab2a59622899a2fe9121969442c20a5fff8ac216c4f4e35fc24f1427f0'

let stack: Stack
let jobs: JobsDeps
let brandId: string
let userId: string

beforeAll(async () => {
  stack = await createStack({ withQueue: true })
  if (!stack.jobs) throw new Error('the stack has no queue')
  jobs = stack.jobs
  brandId = await addBrand(stack, 'job-agent-files')
  userId = await addUser(stack, {
    email: 'owner@jaf.test',
    password: 'correct horse battery',
    platformOwner: true,
  })
}, 120_000)
afterAll(async () => {
  await stack?.close()
})

const inputRow = async (jobId: string) =>
  (await stack.db.admin.query('select agent, files_hash from app.job_input where job_id = $1', [jobId]))
    .rows[0]

describe('a job records the agent files it must run', () => {
  it('a summary job records the live agent and files hash', async () => {
    const { jobId } = await startRun(jobs, brandId, userId)
    expect(await inputRow(jobId)).toEqual({ agent: 'summary', files_hash: SUMMARY_FILES_HASH })
  })

  it('the attempt reply carries the agent and files hash', async () => {
    const { jobId } = await startRun(jobs, brandId, userId)
    await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
      jobId,
    ])
    const started = await startAttempt(jobs, jobId, 'w1')
    expect(started).toMatchObject({ agent: 'summary', filesHash: SUMMARY_FILES_HASH })
  })

  it('a job for an agent with no live release is refused 503 agent_unavailable', async () => {
    const definitionId = await seedDefinition(stack.db, 'no-release')
    const error = await withBrand(stack.appPool, brandId, async (client) => {
      const runId = await createRun(client, brandId, {
        agent: 'no-release',
        definitionVersionId: definitionId,
        startedByKind: 'system',
        startedById: null,
      })
      return createJob(client, jobs, brandId, {
        runId,
        jobClass: 'interactive',
        input: {},
        expectedResultType: 'test.echo',
        agent: 'no-release',
      })
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ status: 503, code: 'agent_unavailable' })
  })

  it('a job without an agent stores neither', async () => {
    const definitionId = await seedDefinition(stack.db, 'no-agent')
    const jobId = await withBrand(stack.appPool, brandId, async (client) => {
      const runId = await createRun(client, brandId, {
        agent: 'no-agent',
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
    expect(await inputRow(jobId)).toEqual({ agent: null, files_hash: null })
  })

  it('a worker that refuses a job marks it dead with a reason even while the queue shows it claimed', async () => {
    const { jobId, runId } = await startRun(jobs, brandId, userId)
    await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
      jobId,
    ])
    await startAttempt(jobs, jobId, 'w1')
    await markDead(jobs, jobId)
    expect(
      (await stack.db.admin.query('select dead_at from app.job_control where job_id = $1', [jobId])).rows[0]
        .dead_at,
    ).toBeNull()
    await markDead(jobs, jobId, 'agent_files_mismatch')
    expect(
      (await stack.db.admin.query('select dead_at from app.job_control where job_id = $1', [jobId])).rows[0]
        .dead_at,
    ).not.toBeNull()
    expect(
      (await stack.db.admin.query('select state from app.run where id = $1', [runId])).rows[0].state,
    ).toBe('failed')
  })
})
