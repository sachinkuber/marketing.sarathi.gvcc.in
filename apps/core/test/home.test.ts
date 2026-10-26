import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  NOW,
  api,
  cast,
  expectMoneyStrings,
  readsStack,
  seedAwaiting,
  seedCall,
  seedJob,
  seedRun,
  statuses,
  type Cast,
} from './reads-support.ts'
import type { Stack } from './support.ts'

let stack: Stack
let c: Cast
let other: Cast
const oldest = new Date(NOW.getTime() - 5 * 86_400_000)

beforeAll(async () => {
  stack = await readsStack()
  c = await cast(stack)
  other = await cast(stack)

  // Runs: three this month (two with cost), one last month.
  const r1 = await seedRun(stack, c.brandId, { usd: 2_000_000n, inr: 166_000_000n })
  const r2 = await seedRun(stack, c.brandId, { usd: 1_000_000n, inr: 83_000_000n, state: 'failed' })
  const r3 = await seedRun(stack, c.brandId, { state: 'running' })
  await seedRun(stack, c.brandId, { usd: 7_000_000n, startedAt: new Date('2026-09-15T00:00:00Z') })

  // Jobs: finished 2, waiting 1, running 1, held 1, dead 1.
  await seedJob(stack, c.brandId, r1, { finished: true, attempts: ['succeeded'] })
  await seedJob(stack, c.brandId, r2, { finished: true, attempts: ['failed'] })
  await seedJob(stack, c.brandId, r3, {})
  await seedJob(stack, c.brandId, r3, { attempts: ['active'] })
  await seedJob(stack, c.brandId, r3, { held: true })
  await seedJob(stack, c.brandId, r3, { dead: true, attempts: ['failed'] })

  // Waiting for approval: two versions.
  await seedAwaiting(stack, c.brandId, oldest)
  await seedAwaiting(stack, c.brandId, new Date(NOW.getTime() - 86_400_000))

  // Alerts: two open, one resolved.
  await stack.db.admin.query(
    `insert into app.alert (brand_id, severity, kind) values ($1, 2, 'a'), ($1, 3, 'b')`,
    [c.brandId],
  )
  await stack.db.admin.query(
    `insert into app.alert (brand_id, severity, kind, resolved_at) values ($1, 3, 'done', now())`,
    [c.brandId],
  )

  // Calls to review: one unknown, one possible duplicate, one fine.
  await seedCall(stack, c.brandId, r1, { status: 'unknown' })
  await seedCall(stack, c.brandId, r1, { possibleDuplicate: true })
})
afterAll(async () => stack?.close())

describe('GET /brands/:brandId/home', () => {
  it('answers every member and the owner, and 404 to a stranger', async () => {
    expect(await statuses(c, 'GET', api(c.brandId, '/home'))).toEqual([200, 200, 200, 200, 404])
  })

  it('gives the owner and the brand admin the whole picture, with money as strings', async () => {
    for (const who of [c.admin, c.owner]) {
      const reply = await who.request('GET', api(c.brandId, '/home'))
      expect(reply.json.results.runsThisMonth).toBe(3)
      expect(reply.json.results.costThisMonth).toEqual({ usdMicros: '3000000', inrMicros: '249000000' })
      expect(reply.json.results.lastRuns).toHaveLength(4)
      expect(reply.json.results.lastRuns[0]).toMatchObject({ agent: 'summary' })
      expect(reply.json.progress).toEqual({
        // Waiting: the plain job and the two jobs behind the calls to review.
        jobs: { waiting: 3, running: 1, held: 1, dead: 1, finished: 2 },
      })
      expect(reply.json.waiting).toEqual({ awaitingApproval: 2, oldestWaitingSince: oldest.toISOString() })
      expect(reply.json.problems).toEqual({ deadJobs: 1, openAlerts: 2, reviewCalls: 2 })
      expectMoneyStrings(reply.json)
    }
  })

  it('hides results and progress from an approver, and waiting from a viewer', async () => {
    const approver = (await c.approver.request('GET', api(c.brandId, '/home'))).json
    expect(approver.results).toBeNull()
    expect(approver.progress).toBeNull()
    expect(approver.waiting).toEqual({ awaitingApproval: 2, oldestWaitingSince: oldest.toISOString() })
    expect(approver.problems).toEqual({ deadJobs: 1, openAlerts: 2, reviewCalls: 2 })
    const viewer = (await c.viewer.request('GET', api(c.brandId, '/home'))).json
    expect(viewer.results).toBeNull()
    expect(viewer.progress).toBeNull()
    expect(viewer.waiting).toBeNull()
  })

  it('shows brand B none of brand A’s figures', async () => {
    const reply = await other.admin.request('GET', api(other.brandId, '/home'))
    expect(reply.json.results).toEqual({
      runsThisMonth: 0,
      costThisMonth: { usdMicros: '0', inrMicros: '0' },
      lastRuns: [],
    })
    expect(reply.json.progress).toEqual({ jobs: { waiting: 0, running: 0, held: 0, dead: 0, finished: 0 } })
    expect(reply.json.waiting).toEqual({ awaitingApproval: 0, oldestWaitingSince: null })
    expect(reply.json.problems).toEqual({ deadJobs: 0, openAlerts: 0, reviewCalls: 0 })
  })
})

describe('home after the work engine has run a job', () => {
  it('moves a job from waiting to running as the service starts it, and shows the run', async () => {
    const { createJob, createRun, startAttempt } = await import('../src/jobs/service.ts')
    const { withBrand } = await import('@mkt/db')
    const live = await readsStack(undefined, { withQueue: true })
    try {
      const mine = await cast(live)
      const def = await live.db.admin.query(
        "select id from app.agent_definition_version where agent = 'summary' and live",
      )
      const jobId = await withBrand(live.appPool, mine.brandId, async (client) => {
        const runId = await createRun(client, mine.brandId, {
          agent: 'summary',
          definitionVersionId: def.rows[0].id,
          startedByKind: 'system',
          startedById: null,
        })
        return createJob(client, live.jobs!, mine.brandId, {
          runId,
          jobClass: 'interactive',
          input: {},
          expectedResultType: 'test.echo',
        })
      })
      const waiting = (await mine.admin.request('GET', api(mine.brandId, '/home'))).json
      expect(waiting.progress.jobs).toEqual({ waiting: 1, running: 0, held: 0, dead: 0, finished: 0 })
      expect(waiting.results.lastRuns).toHaveLength(1)
      await live.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
        jobId,
      ])
      await startAttempt(live.jobs!, jobId, 'w1')
      const running = (await mine.admin.request('GET', api(mine.brandId, '/home'))).json
      expect(running.progress.jobs).toEqual({ waiting: 0, running: 1, held: 0, dead: 0, finished: 0 })
      expect(running.results.lastRuns[0].state).toBe('running')
    } finally {
      await live.close()
    }
  })
})
