import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { sleep } from '@mkt/test-support'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { httpCoreClient } from '../../worker/src/core-client.ts'
import { startWorker } from '../../worker/src/main.ts'
import type { ModelClient } from '../../worker/src/model.ts'
import type { JobHandler } from '../../worker/src/runner.ts'
import { markDead, requeueJob } from '../src/jobs/dead.ts'
import { createJob, createRun, readControl, type JobsDeps } from '../src/jobs/service.ts'
import { setSwitch } from '../src/killswitch/service.ts'
import {
  addBrand,
  addUser,
  createStack,
  enrolledClient,
  totp,
  type Stack,
  type TestClient,
} from './support.ts'

// Acceptance tests 30 and 31 (spec 9.4, 13): the kill switch against the real queue, the real HTTP core and
// a real worker (the runner over the queue, in this process so the stand-in model can be counted and paused).

const PASSWORD = 'correct horse battery'
const RESULT_TYPE = 'test.one_step'

let stack: Stack
let jobs: JobsDeps
let definitionId: string
let seq = 0

// The stand-in model: counts every request it is sent, per job, and can be paused mid-call.
const modelCalls = new Map<string, number>()
let gate: { entered: () => void; release: Promise<void> } | null = null
const model: ModelClient = {
  async send(request) {
    const jobId = request.messages[0]!.content
    modelCalls.set(jobId, (modelCalls.get(jobId) ?? 0) + 1)
    if (gate) {
      const g = gate
      g.entered()
      await g.release
    }
    return {
      text: `reply:${jobId}`,
      messageId: `msg_${Math.random().toString(36).slice(2, 10)}`,
      requestId: null,
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
  },
}
const totalCalls = (ids: string[]) => ids.reduce((n, id) => n + (modelCalls.get(id) ?? 0), 0)

const oneStep: JobHandler = async (ctx) => {
  const out = await ctx.modelStep('only', {
    model: 'test-model',
    messages: [{ role: 'user', content: ctx.jobId }],
    maxTokens: 10,
  })
  return { type: RESULT_TYPE, result: { text: out.text } }
}

// The result handler a real agent would register: it would create a content version. Here it records the
// call, so the tests can show it was not called while the job was held, and called once after release.
const applied: string[] = []
// Jobs whose result handler throws (the release must survive it).
const failing = new Set<string>()
class HandlerBoom extends Error {
  override name = 'HandlerBoom'
}

let worker: { stop(): Promise<void> } | null = null
async function startTestWorker(id: string): Promise<void> {
  worker = await startWorker({
    core: httpCoreClient(stack.server.url, jobs.workerSecret),
    model,
    handlers: { [RESULT_TYPE]: oneStep },
    queueUrl: stack.db.urlFor('queue'),
    workerId: id,
    classes: ['interactive'],
    processesPerClass: 1,
    superviseIntervalSeconds: 1,
    log: () => {},
  })
}
async function stopTestWorker(): Promise<void> {
  const w = worker
  worker = null
  await w?.stop()
}

beforeAll(async () => {
  stack = await createStack({ withQueue: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  definitionId = await seedDefinition(stack.db)
  jobs.results.set(RESULT_TYPE, async (_client, ctx) => {
    if (failing.has(ctx.jobId)) throw new HandlerBoom('content that must not reach the audit log')
    applied.push(ctx.jobId)
    return { jobId: ctx.jobId }
  })
}, 120_000)
afterEach(async () => {
  gate = null
  await stopTestWorker()
})
afterAll(async () => {
  await stack?.close()
})

interface Setup {
  brandId: string
  adminId: string
  admin: TestClient
  secret: string
}

async function makeBrand(): Promise<Setup> {
  seq += 1
  const brandId = await addBrand(stack, `ksj-${seq}`)
  const adminId = await addUser(stack, {
    email: `ksj${seq}@example.test`,
    password: PASSWORD,
    role: 'brand_admin',
    brandId,
  })
  const admin = await enrolledClient(stack, `ksj${seq}@example.test`, PASSWORD)
  return { brandId, adminId, admin: admin.client, secret: admin.secret }
}

async function newJob(brandId: string): Promise<string> {
  return withBrand(stack.appPool, brandId, async (client) => {
    const runId = await createRun(client, brandId, {
      agent: 'writer',
      definitionVersionId: definitionId,
      startedByKind: 'system',
      startedById: null,
    })
    return createJob(client, jobs, brandId, {
      runId,
      jobClass: 'interactive',
      input: {},
      expectedResultType: RESULT_TYPE,
    })
  })
}

const setBrandSwitch = (b: Setup) =>
  setSwitch(
    stack.appPool,
    { audit: jobs.audit },
    { brandId: b.brandId, scope: 'brand', target: null, actor: b.adminId },
  )

// Released through the HTTP route, so the release path the service wires up is the one tested.
async function release(b: Setup): Promise<{ released: boolean; unheld: number }> {
  const reply = await b.admin.request('POST', `/api/v1/brands/${b.brandId}/kill-switch/release`, {
    body: { scope: 'brand', code: totp(b.secret) },
  })
  if (reply.status !== 200) throw new Error(`release failed: ${reply.status} ${reply.text}`)
  return reply.json as { released: boolean; unheld: number }
}

async function until(check: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error('condition not reached in time')
}

// The queue rows of a job (the first send and any release's), by state.
async function queueRows(jobId: string): Promise<string[]> {
  const { rows } = await stack.db.admin.query<{ state: string }>(
    `select state from pgboss.job where name = 'job-interactive' and data->>'jobId' = $1 order by created_on`,
    [jobId],
  )
  return rows.map((r) => r.state)
}

async function finished(ids: string[]): Promise<number> {
  const { rows } = await stack.db.admin.query<{ n: number }>(
    'select count(*)::int as n from app.job_input where job_id = any($1) and finished_at is not null',
    [ids],
  )
  return rows[0]!.n
}

async function brandEffects(
  brandId: string,
): Promise<{ versions: number; notifications: number; jobs: number }> {
  const { rows } = await stack.db.admin.query<{ versions: number; notifications: number; jobs: number }>(
    `select (select count(*)::int from app.content_version where brand_id = $1) as versions,
            (select count(*)::int from app.notification where brand_id = $1) as notifications,
            (select count(*)::int from app.job_input where brand_id = $1) as jobs`,
    [brandId],
  )
  return rows[0]!
}

async function heldFlag(jobId: string): Promise<boolean> {
  const { rows } = await stack.db.admin.query('select held from app.job_control where job_id = $1', [jobId])
  return rows[0]!.held as boolean
}

// What the library does after the last retry: the job's queue row is failed (as in jobs-dead.test.ts).
async function dieInQueue(jobId: string): Promise<void> {
  await stack.db.admin.query(`update pgboss.job set state = 'failed' where id = $1`, [jobId])
  await markDead(jobs, jobId)
}

describe('test 30: the kill switch set while jobs wait', () => {
  it('holds them with no model call; release runs each exactly once, whether its queue row was waiting or completed', async () => {
    const b = await makeBrand()
    const early = [await newJob(b.brandId), await newJob(b.brandId), await newJob(b.brandId)]
    expect((await setBrandSwitch(b)).held).toBe(3)

    // A worker claims the three waiting jobs: each is answered held, no attempt is made, and the queue
    // completes its row.
    await startTestWorker('w30a')
    await until(async () => {
      const states = await Promise.all(early.map(queueRows))
      return states.every((s) => s.length === 1 && s[0] === 'completed')
    })
    await stopTestWorker()
    // Two more arrive while the switch is on: born held, still waiting in the queue at release.
    const late = [await newJob(b.brandId), await newJob(b.brandId)]
    const all = [...early, ...late]
    for (const id of late) expect(await queueRows(id)).toEqual(['created'])

    const held = await stack.db.admin.query(
      'select count(*)::int as n from app.job_control where job_id = any($1) and held',
      [all],
    )
    expect(held.rows[0].n).toBe(5)
    expect(totalCalls(all)).toBe(0)
    const attempts = await stack.db.admin.query(
      'select count(*)::int as n from app.job_attempt where job_id = any($1)',
      [all],
    )
    expect(attempts.rows[0].n).toBe(0)
    expect(await finished(all)).toBe(0)
    expect(applied.filter((id) => all.includes(id))).toEqual([])

    expect(await release(b)).toEqual({ released: true, unheld: 5 })
    await startTestWorker('w30b')
    await until(async () => (await finished(all)) === 5)
    // The waiting copies of the late jobs are superseded by the release's: claimed, answered, completed.
    await until(async () => {
      const states = await Promise.all(all.map(queueRows))
      return states.every((s) => s.every((x) => x === 'completed'))
    })

    for (const id of all) expect(modelCalls.get(id)).toBe(1)
    expect(totalCalls(all)).toBe(5)
    expect(applied.filter((id) => all.includes(id)).sort()).toEqual([...all].sort())
    const done = await stack.db.admin.query<{ job_id: string; n: number }>(
      `select job_id, count(*)::int as n from app.job_attempt where job_id = any($1) and state = 'succeeded'
        group by job_id`,
      [all],
    )
    expect(done.rows).toHaveLength(5)
    expect(done.rows.every((r) => r.n === 1)).toBe(true)
    // One release copy per job: the first send and the release's.
    for (const id of early) expect(await queueRows(id)).toEqual(['completed', 'completed'])
    for (const id of late) expect(await queueRows(id)).toEqual(['completed', 'completed'])

    // Releasing again changes nothing: no switch is active, nothing is sent again.
    expect(await release(b)).toEqual({ released: false, unheld: 0 })
    await sleep(1500)
    for (const id of all) expect(await queueRows(id)).toHaveLength(2)
    expect(totalCalls(all)).toBe(5)
  }, 240_000)
})

describe('test 31: the kill switch set while a job is running', () => {
  async function runIntoHold(b: Setup): Promise<string> {
    let entered!: () => void
    const inCall = new Promise<void>((resolve) => (entered = resolve))
    let open!: () => void
    gate = { entered, release: new Promise<void>((resolve) => (open = resolve)) }
    const jobId = await newJob(b.brandId)
    await startTestWorker(`w31-${jobId.slice(0, 8)}`)
    // The model call is in flight when the switch is set; it cannot be recalled.
    await inCall
    expect((await setBrandSwitch(b)).held).toBe(1)
    open()
    // The worker posts its result anyway: the core keeps it as held, and the queue completes the row.
    await until(async () => {
      const { rows } = await stack.db.admin.query('select held_result from app.job_input where job_id = $1', [
        jobId,
      ])
      return rows[0]?.held_result != null
    })
    await until(async () => (await queueRows(jobId)).join() === 'completed')
    await stopTestWorker()
    return jobId
  }

  it('keeps the result held (no version, job or notification); release applies it exactly once', async () => {
    const b = await makeBrand()
    const jobId = await runIntoHold(b)

    expect(applied).not.toContain(jobId)
    expect(await brandEffects(b.brandId)).toEqual({ versions: 0, notifications: 0, jobs: 1 })
    expect(await finished([jobId])).toBe(0)
    expect(modelCalls.get(jobId)).toBe(1)

    // A worker is running at release: if the job were sent again it would run.
    await startTestWorker('w31-after')
    expect(await release(b)).toEqual({ released: true, unheld: 1 })
    // Applied in the release itself, through the registered handler, exactly once.
    expect(applied.filter((id) => id === jobId)).toHaveLength(1)
    const row = await stack.db.admin.query(
      `select i.held_result, i.finished_at, i.outcome, r.state as run_state
         from app.job_input i join app.run r on r.id = i.run_id where i.job_id = $1`,
      [jobId],
    )
    expect(row.rows[0].held_result).toBeNull()
    expect(row.rows[0].finished_at).not.toBeNull()
    expect(row.rows[0].outcome).toEqual({ jobId })
    expect(row.rows[0].run_state).toBe('succeeded')
    const attempts = await stack.db.admin.query(
      'select state from app.job_attempt where job_id = $1 order by attempt_number',
      [jobId],
    )
    expect(attempts.rows.map((r) => r.state)).toEqual(['succeeded'])

    // Not sent again: the queue row completed while held is the only one, and no model call follows.
    await sleep(2000)
    expect(await queueRows(jobId)).toEqual(['completed'])
    expect(modelCalls.get(jobId)).toBe(1)
    expect(await release(b)).toEqual({ released: false, unheld: 0 })
    expect(applied.filter((id) => id === jobId)).toHaveLength(1)
  }, 240_000)

  it('a held result whose handler throws: the release succeeds, the result is discarded and audited with the error name, and the job is sent again', async () => {
    const b = await makeBrand()
    const jobId = await runIntoHold(b)
    failing.add(jobId)

    expect(await release(b)).toEqual({ released: true, unheld: 1 })
    expect(applied).not.toContain(jobId)
    const row = await stack.db.admin.query(
      'select held_result, finished_at from app.job_input where job_id = $1',
      [jobId],
    )
    expect(row.rows[0]).toEqual({ held_result: null, finished_at: null })
    const discarded = stack.audit.entries.filter(
      (e) => e.action === 'jobs.held_result_discarded' && e.subject === jobId,
    )
    expect(discarded).toHaveLength(1)
    expect(discarded[0]!.detail).toEqual({ jobId, reason: 'not_applied', error: 'HandlerBoom' })
    expect(JSON.stringify(discarded[0]!.detail)).not.toContain('must not reach')
    // What the code does: the job is sent again under a new queue id, like any freed job.
    expect(await queueRows(jobId)).toEqual(['completed', 'created'])

    // Once the handler accepts it, the new copy runs: its step is checkpointed, so no second model call.
    failing.delete(jobId)
    await startTestWorker('w31-boom')
    await until(async () => (await finished([jobId])) === 1)
    expect(applied.filter((id) => id === jobId)).toHaveLength(1)
    expect(modelCalls.get(jobId)).toBe(1)
  }, 240_000)

  it('discards a held result whose attempt was ended, and runs the job again once instead', async () => {
    const b = await makeBrand()
    const jobId = await runIntoHold(b)
    // The attempt that posted the result is no longer current (as after a reclaim or a dead mark).
    await stack.db.admin.query(
      `update app.job_attempt set state = 'superseded', ended_at = now() where job_id = $1`,
      [jobId],
    )

    expect(await release(b)).toEqual({ released: true, unheld: 1 })
    expect(applied).not.toContain(jobId)
    const cleared = await stack.db.admin.query('select held_result from app.job_input where job_id = $1', [
      jobId,
    ])
    expect(cleared.rows[0].held_result).toBeNull()
    const discarded = stack.audit.entries.filter(
      (e) => e.action === 'jobs.held_result_discarded' && e.subject === jobId,
    )
    expect(discarded).toHaveLength(1)

    await startTestWorker('w31-stale')
    await until(async () => (await finished([jobId])) === 1)
    expect(applied.filter((id) => id === jobId)).toHaveLength(1)
    // The step was checkpointed by the held attempt, so the new attempt makes no second model call.
    expect(modelCalls.get(jobId)).toBe(1)
    expect(await queueRows(jobId)).toEqual(['completed', 'completed'])
  }, 240_000)
})

describe('release and the other paths of the work engine', () => {
  it('a job that died while held runs after release and requeue; requeued under an active switch it is held again', async () => {
    const b = await makeBrand()
    // Dies on its last try while the switch is on: a release skips dead jobs, so it keeps its held flag.
    const j1 = await newJob(b.brandId)
    expect((await setBrandSwitch(b)).held).toBe(1)
    await dieInQueue(j1)
    expect(await release(b)).toEqual({ released: true, unheld: 0 })
    expect(await heldFlag(j1)).toBe(true)
    // The requeue clears the flag; no switch is active, so the job runs and finishes.
    await requeueJob(jobs, b.brandId, j1, b.adminId)
    expect(await heldFlag(j1)).toBe(false)
    await startTestWorker('w-dead-1')
    await until(async () => (await finished([j1])) === 1)
    expect(modelCalls.get(j1)).toBe(1)
    expect(applied.filter((id) => id === j1)).toHaveLength(1)
    await stopTestWorker()

    // Requeued while the switch is still on: the start re-derives the hold from the active switch.
    const j2 = await newJob(b.brandId)
    expect((await setBrandSwitch(b)).held).toBe(1)
    await dieInQueue(j2)
    await requeueJob(jobs, b.brandId, j2, b.adminId)
    await startTestWorker('w-dead-2')
    await until(async () => (await heldFlag(j2)) && (await queueRows(j2)).join() === 'completed')
    expect(modelCalls.get(j2)).toBeUndefined()
    expect(await finished([j2])).toBe(0)
    // The switch's release then sends it, and it runs once.
    expect(await release(b)).toEqual({ released: true, unheld: 1 })
    await until(async () => (await finished([j2])) === 1)
    expect(modelCalls.get(j2)).toBe(1)
    expect(applied.filter((id) => id === j2)).toHaveLength(1)
  }, 240_000)

  it('a release and a dead mark on the same job do not deadlock: both take job_input first', async () => {
    const b = await makeBrand()
    const jobId = await newJob(b.brandId)
    expect((await setBrandSwitch(b)).held).toBe(1)
    // A transaction shaped like markDead: the job's input row first, then its control row.
    const other = await stack.db.admin.connect()
    try {
      await other.query('begin')
      await other.query('select 1 from app.job_input where job_id = $1 for update', [jobId])
      const releasing = release(b)
      // The release is now waiting for the input row. It must not hold the control row while it waits.
      await until(async () => {
        const { rows } = await stack.db.admin.query(
          `select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
        )
        return rows[0].n > 0
      }, 20_000)
      await other.query('update app.job_control set updated_at = now() where job_id = $1', [jobId])
      await other.query('commit')
      expect(await releasing).toEqual({ released: true, unheld: 1 })
    } finally {
      other.release()
    }
    expect(await heldFlag(jobId)).toBe(false)
  }, 60_000)

  it('a derived hold is not written once a release that was in flight commits: the job is not stranded', async () => {
    const b = await makeBrand()
    const jobId = await newJob(b.brandId)
    // The state a requeue under an active switch leaves: the switch covers the job, its flag is false.
    await stack.db.admin.query(
      `insert into app.kill_switch (brand_id, scope, active, set_by) values ($1, 'brand', true, $2)`,
      [b.brandId, b.adminId],
    )
    expect(await heldFlag(jobId)).toBe(false)
    // A release in flight: it holds the brand row, as set and release do, and has not yet committed.
    const releasing = await stack.db.admin.connect()
    try {
      await releasing.query('begin')
      await releasing.query('select 1 from app.brand where id = $1 for update', [b.brandId])
      const reading = withBrand(stack.appPool, b.brandId, (client) => readControl(client, jobId))
      const first = await Promise.race([reading.then(() => 'done'), sleep(1500).then(() => 'waiting')])
      // The read must wait for the release, not write the flag under it.
      expect(first).toBe('waiting')
      await releasing.query(
        'update app.kill_switch set active = false, released_by = $2, released_at = now() where brand_id = $1',
        [b.brandId, b.adminId],
      )
      await releasing.query('commit')
      expect((await reading).held).toBe(false)
    } finally {
      releasing.release()
    }
    expect(await heldFlag(jobId)).toBe(false)
  }, 60_000)

  it('release during an in-flight model call: applied once, the second call is flagged a possible duplicate (known limitation)', async () => {
    const b = await makeBrand()
    let entered!: () => void
    const inCall = new Promise<void>((resolve) => (entered = resolve))
    let open!: () => void
    gate = { entered, release: new Promise<void>((resolve) => (open = resolve)) }
    const jobId = await newJob(b.brandId)
    await startTestWorker('w-inflight')
    await inCall
    expect((await setBrandSwitch(b)).held).toBe(1)
    // Released while the first call is still paused: the job is sent again, and the new copy's attempt
    // supersedes the paused one and sends the same step again.
    expect(await release(b)).toEqual({ released: true, unheld: 1 })
    await until(async () => modelCalls.get(jobId) === 2)
    open()
    await until(async () => (await finished([jobId])) === 1)
    // The paused attempt's checkpoint is refused; its queue copy is retried and turned away as superseded.
    await until(async () => (await queueRows(jobId)).every((x) => x === 'completed'), 90_000)
    expect(applied.filter((id) => id === jobId)).toHaveLength(1)
    expect(modelCalls.get(jobId)).toBe(2)
    const calls = await stack.db.admin.query<{ possible_duplicate: boolean }>(
      'select possible_duplicate from app.model_call where job_id = $1 order by started_at',
      [jobId],
    )
    expect(calls.rows.map((r) => r.possible_duplicate)).toEqual([false, true])
  }, 240_000)
})
