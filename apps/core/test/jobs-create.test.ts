import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand, type PoolClient } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { createJob, createRun, type JobsDeps } from '../src/jobs/service.ts'
import { AppError } from '../src/errors.ts'
import { addBrand, createStack, type Stack } from './support.ts'

let stack: Stack
let jobs: JobsDeps
let brandId: string
let definitionId: string

beforeAll(async () => {
  stack = await createStack({ withQueue: true, backlogLimit: 2 })
  if (!stack.jobs) throw new Error('the stack has no queue')
  jobs = stack.jobs
  brandId = await addBrand(stack, 'jobs-create')
  definitionId = await seedDefinition(stack.db)
})
afterAll(async () => {
  await stack?.close()
})

const newRun = (client: PoolClient) =>
  createRun(client, brandId, {
    agent: 'test-agent',
    definitionVersionId: definitionId,
    startedByKind: 'system',
    startedById: null,
  })

describe('creating a job with its cause', () => {
  it('writes the run, the job input, the control row and the queue row together', async () => {
    let jobId = ''
    await withBrand(stack.appPool, brandId, async (client) => {
      const runId = await newRun(client)
      jobId = await createJob(client, jobs, brandId, {
        runId,
        jobClass: 'production',
        input: { topic: 'launch' },
        expectedResultType: 'test.echo',
      })
    })
    const input = await withBrand(stack.appPool, brandId, (c) =>
      c.query('select class, input, run_id from app.job_input where job_id = $1', [jobId]),
    )
    const control = await withBrand(stack.appPool, brandId, (c) =>
      c.query('select held, cancel_requested from app.job_control where job_id = $1', [jobId]),
    )
    const run = await withBrand(stack.appPool, brandId, (c) =>
      c.query('select started_by_kind, state from app.run where id = $1', [input.rows[0].run_id]),
    )
    expect(input.rows[0]).toMatchObject({ class: 'production', input: { topic: 'launch' } })
    expect(control.rows[0]).toEqual({ held: false, cancel_requested: false })
    expect(run.rows[0]).toMatchObject({ started_by_kind: 'system' })
    expect(await jobs.queue.state('production', jobId)).toBe('created')
  })

  it('leaves no job, no input and no queue row when the business transaction rolls back', async () => {
    let jobId = ''
    await expect(
      withBrand(stack.appPool, brandId, async (client) => {
        const runId = await newRun(client)
        jobId = await createJob(client, jobs, brandId, {
          runId,
          jobClass: 'interactive',
          input: {},
          expectedResultType: 'test.echo',
        })
        throw new Error('the business change failed')
      }),
    ).rejects.toThrow('the business change failed')
    expect(await jobs.queue.state('interactive', jobId)).toBeNull()
    const rows = await withBrand(stack.appPool, brandId, (c) =>
      c.query('select 1 from app.job_input where job_id = $1', [jobId]),
    )
    expect(rows.rowCount).toBe(0)
  })

  it('refuses a production job when the class backlog is at its limit, and still accepts an interactive one', async () => {
    const make = (jobClass: 'production' | 'interactive') =>
      withBrand(stack.appPool, brandId, async (client) => {
        const runId = await newRun(client)
        return createJob(client, jobs, brandId, {
          runId,
          jobClass,
          input: {},
          expectedResultType: 'test.echo',
        })
      })
    // The first test already queued one production job; with a limit of 2, one more fits and the next does not.
    await make('production')
    await expect(make('production')).rejects.toMatchObject({
      status: 503,
      code: 'queue_busy',
    } satisfies Partial<AppError>)
    await expect(make('interactive')).resolves.toMatch(/^[0-9a-f-]{36}$/)
  })

  it('gives every job a scheduling key that is not the brand ID', async () => {
    const { rows } = await stack.db.admin.query<{ group_id: string }>(
      `select group_id from pgboss.job where name = 'job-production' limit 1`,
    )
    const brand = await stack.db.admin.query<{ schedule_key: string }>(
      'select schedule_key from app.brand where id = $1',
      [brandId],
    )
    expect(rows[0]?.group_id).toBe(brand.rows[0]?.schedule_key)
    expect(rows[0]?.group_id).not.toBe(brandId)
  })
})
