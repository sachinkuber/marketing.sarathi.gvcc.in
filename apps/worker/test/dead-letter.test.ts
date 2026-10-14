import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { sleep } from '@mkt/test-support'
import { listDead, requeueJob } from '../../core/src/jobs/dead.ts'
import { createJob, createRun, type JobsDeps } from '../../core/src/jobs/service.ts'
import { addBrand, createStack, type Stack } from '../../core/test/support.ts'
import { httpCoreClient } from '../src/core-client.ts'
import { startWorker } from '../src/main.ts'
import { standInModel } from '../src/standin.ts'

let stack: Stack
let jobs: JobsDeps
let brand: string
let definitionId: string
let worker: { stop(): Promise<void> }
let shouldFail = true
let handlerRuns = 0
const OWNER = '88888888-8888-4888-8888-888888888888'

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('the stack has no queue')
  jobs = stack.jobs
  brand = await addBrand(stack, 'dead-letter')
  definitionId = await seedDefinition(stack.db)
  jobs.results.set('test.flaky', async () => ({ ok: true }))
  worker = await startWorker({
    core: httpCoreClient(stack.server.url, jobs.workerSecret),
    model: standInModel({ logFile: '/dev/null' }),
    handlers: {
      'test.flaky': async () => {
        handlerRuns += 1
        if (shouldFail) throw new Error('boom')
        return { type: 'test.flaky', result: {} }
      },
    },
    queueUrl: stack.db.urlFor('queue'),
    workerId: 'in-process',
    classes: ['interactive'],
    processesPerClass: 1,
    superviseIntervalSeconds: 1,
  })
}, 120_000)

afterAll(async () => {
  await worker?.stop()
  await stack?.close()
})

async function until(check: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(500)
  }
  throw new Error('condition not reached in time')
}

describe('acceptance test 28', () => {
  it('a job that keeps failing lands in the dead-letter list and can be requeued', async () => {
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
        expectedResultType: 'test.flaky',
      })
    })

    // Three attempts (retryLimit 2, plus the first), then the library gives up and the watcher marks it.
    await until(async () => (await listDead(jobs, brand)).some((j) => j.jobId === jobId), 150_000)
    expect(handlerRuns).toBe(3)
    const attempts = await stack.db.admin.query('select state from app.job_attempt where job_id = $1', [
      jobId,
    ])
    expect(attempts.rowCount).toBe(3)
    expect(attempts.rows.every((r) => r.state !== 'active')).toBe(true)
    expect(
      (await stack.db.admin.query('select state from app.run where id = $1', [runId])).rows[0].state,
    ).toBe('failed')

    shouldFail = false
    await requeueJob(jobs, brand, jobId, OWNER)
    await until(
      async () =>
        (await stack.db.admin.query('select finished_at from app.job_input where job_id = $1', [jobId]))
          .rows[0].finished_at !== null,
      90_000,
    )
    expect(await listDead(jobs, brand)).toEqual([])
    expect(
      (await stack.db.admin.query('select state from app.run where id = $1', [runId])).rows[0].state,
    ).toBe('succeeded')

    const actions = await stack.db.admin.query(
      `select action from audit.log where subject = $1 order by at`,
      [jobId],
    )
    expect(actions.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['jobs.dead', 'jobs.requeued']))
  }, 300_000)
})
