import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { sleep } from '@mkt/test-support'
import { createJob, createRun, type JobsDeps } from '../../core/src/jobs/service.ts'
import { addBrand, createStack, type Stack } from '../../core/test/support.ts'

let stack: Stack
let jobs: JobsDeps
let brand: string
let definitionId: string
let applied = 0
const children: ChildProcess[] = []

beforeAll(async () => {
  // The stack's clock is the real one (no `now` is passed), so the attempt tokens the real HTTP server
  // issues to the forked workers are valid, and prices and rates are dated from the service's own clock.
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('the stack has no queue')
  jobs = stack.jobs
  brand = await addBrand(stack, 'crash')
  definitionId = await seedDefinition(stack.db)
  const today = jobs.now().toISOString().slice(0, 10)
  await stack.db.admin.query(
    `insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, source)
     values ('test-model', $1::date - 30, 4000000, 20000000, 200000, 5000000, 'test')`,
    [today],
  )
  await stack.db.admin.query(`select app.record_fx_rate($1::date - 1, 83500000, 'test')`, [today])
  jobs.results.set('test.three_steps', async (_client, ctx) => {
    applied += 1
    return { jobId: ctx.jobId }
  })
}, 120_000)

// A worker left running by one test would claim the next test's job before that test's own crashing worker
// can, and the crash would never happen. Each test starts with no worker alive.
afterEach(async () => {
  const running = children.splice(0)
  await Promise.all(
    running.map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.exitCode !== null || c.signalCode !== null) return resolve()
          c.once('exit', () => resolve())
          c.kill('SIGKILL')
        }),
    ),
  )
})

afterAll(async () => {
  await stack?.close()
})

function startChild(logFile: string, extra: Record<string, string>): ChildProcess {
  const child = fork(new URL('./child.ts', import.meta.url).pathname, [], {
    execArgv: ['--experimental-strip-types'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CORE_URL: stack.server.url,
      WORKER_SECRET: jobs.workerSecret,
      QUEUE_DATABASE_URL: stack.db.urlFor('queue'),
      MODEL_LOG: logFile,
      ...extra,
    },
  })
  children.push(child)
  return child
}

async function createThreeStepJob(): Promise<string> {
  return withBrand(stack.appPool, brand, async (client) => {
    const runId = await createRun(client, brand, {
      agent: 'test-agent',
      definitionVersionId: definitionId,
      startedByKind: 'system',
      startedById: null,
    })
    return createJob(client, jobs, brand, {
      runId,
      jobClass: 'interactive',
      input: {},
      expectedResultType: 'test.three_steps',
    })
  })
}

async function untilFinished(jobId: string, ms = 90_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const { rows } = await stack.db.admin.query('select finished_at from app.job_input where job_id = $1', [
      jobId,
    ])
    if (rows[0]?.finished_at) return
    await sleep(500)
  }
  throw new Error('the job did not finish')
}

const sentCount = (log: string, step: string) => log.split('\n').filter((l) => l === `sent ${step}`).length

describe('a worker that is killed', () => {
  it('test 24: killed mid-job, the job is claimed again as a new attempt and every step with a checkpoint is skipped', async () => {
    const log = join(tmpdir(), `crash24-${randomUUID()}.log`)
    const before = applied
    const jobId = await createThreeStepJob()

    const first = startChild(log, { CRASH_BEFORE_REPLY_ON: 'step2', WORKER_ID: 'first' })
    await new Promise((resolve) => first.once('exit', resolve))

    startChild(log, { WORKER_ID: 'second' })
    await untilFinished(jobId)

    const sent = await readFile(log, 'utf8')
    expect(sentCount(sent, 'step1')).toBe(1) // checkpointed before the crash: never sent again
    expect(sentCount(sent, 'step2')).toBe(2) // the call the crash interrupted, sent again by the new attempt
    expect(sentCount(sent, 'step3')).toBe(1)

    const attempts = await stack.db.admin.query<{
      attempt_number: number
      state: string
      worker_id: string
    }>(
      'select attempt_number, state, worker_id from app.job_attempt where job_id = $1 order by attempt_number',
      [jobId],
    )
    expect(attempts.rows).toEqual([
      { attempt_number: 1, state: 'superseded', worker_id: 'first' },
      { attempt_number: 2, state: 'succeeded', worker_id: 'second' },
    ])
    expect(applied).toBe(before + 1)
    await rm(log, { force: true })
  }, 180_000)

  it('test 25: killed after the model replied and before the checkpoint, the retry sends again, is flagged, both calls are in the ledger and one result is applied', async () => {
    const log = join(tmpdir(), `crash25-${randomUUID()}.log`)
    const before = applied
    const jobId = await createThreeStepJob()

    const first = startChild(log, { CRASH_AFTER_REPLY_ON: 'step3', WORKER_ID: 'first' })
    await new Promise((resolve) => first.once('exit', resolve))

    startChild(log, { WORKER_ID: 'second' })
    await untilFinished(jobId)

    const sent = await readFile(log, 'utf8')
    expect(sentCount(sent, 'step1')).toBe(1)
    expect(sentCount(sent, 'step2')).toBe(1)
    expect(sentCount(sent, 'step3')).toBe(2)

    const calls = await stack.db.admin.query<{
      step: string
      status: string
      possible_duplicate: boolean
    }>(
      `select step, status, possible_duplicate from app.model_call where job_id = $1 order by step, started_at`,
      [jobId],
    )
    expect(calls.rows).toEqual([
      { step: 'step1', status: 'succeeded', possible_duplicate: false },
      { step: 'step2', status: 'succeeded', possible_duplicate: false },
      { step: 'step3', status: 'started', possible_duplicate: false },
      { step: 'step3', status: 'succeeded', possible_duplicate: true },
    ])
    // The interrupted call was charged by the provider but never reached the ledger: it is the one
    // reconciliation will mark unknown (task 10). Three costs are recorded, one per checkpointed call.
    const costs = await stack.db.admin.query(
      'select count(*)::int as n from app.cost_ledger c join app.model_call m on m.id = c.model_call_id where m.job_id = $1',
      [jobId],
    )
    expect(costs.rows[0].n).toBe(3)
    expect(applied).toBe(before + 1)
    await rm(log, { force: true })
  }, 180_000)
})
