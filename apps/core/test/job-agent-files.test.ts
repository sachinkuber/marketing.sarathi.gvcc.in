import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { createJob, createRun, startAttempt, type JobsDeps } from '../src/jobs/service.ts'
import { AppError } from '../src/errors.ts'
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
        agent: 'run-of-another',
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

  it("a job for the run's own agent takes the hash of the version the run is pinned to", async () => {
    const pinned = await seedDefinition(stack.db, 'pinned-agent')
    const jobId = await withBrand(stack.appPool, brandId, async (client) => {
      const runId = await createRun(client, brandId, {
        agent: 'pinned-agent',
        definitionVersionId: pinned,
        startedByKind: 'system',
        startedById: null,
      })
      return createJob(client, jobs, brandId, {
        runId,
        jobClass: 'interactive',
        input: {},
        expectedResultType: 'test.echo',
        agent: 'pinned-agent',
      })
    })
    // seedDefinition gives a version that is not live, with the hash 'test'.
    expect(await inputRow(jobId)).toEqual({ agent: 'pinned-agent', files_hash: 'test' })
  })

  it("a job for another agent in the run takes that agent's live hash", async () => {
    const definitionId = await seedDefinition(stack.db, 'run-agent')
    const jobId = await withBrand(stack.appPool, brandId, async (client) => {
      const runId = await createRun(client, brandId, {
        agent: 'run-agent',
        definitionVersionId: definitionId,
        startedByKind: 'system',
        startedById: null,
      })
      return createJob(client, jobs, brandId, {
        runId,
        jobClass: 'interactive',
        input: {},
        expectedResultType: 'test.echo',
        agent: 'summary',
      })
    })
    expect(await inputRow(jobId)).toEqual({ agent: 'summary', files_hash: SUMMARY_FILES_HASH })
  })
})
