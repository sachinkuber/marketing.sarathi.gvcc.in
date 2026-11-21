import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { sleep } from '@mkt/test-support'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerSummaryHandlers } from '../src/agents/register.ts'
import { tick } from '../src/approvals/requests.ts'
import { approve } from '../src/approvals/service.ts'
import { ManualClock } from '../src/notify/doubles.ts'
import { createVersion, moveState } from '../src/content/versions.ts'
import { createJob, createRun, postResult, type JobsDeps } from '../src/jobs/service.ts'
import { releaseHeldJobs } from '../src/killswitch/release.ts'
import { releaseSwitch, setSwitch } from '../src/killswitch/service.ts'
import { replaceFact, retireFact } from '../src/onboarding/facts-rules.ts'
import { factHash } from '../src/onboarding/suggestions.ts'
import { BRIEF, GOOD_RESULT, claim, startRun } from './summary-support.ts'
import { addBrand, addUser, createStack, type Stack } from './support.ts'

// One lock order everywhere: brand row, job_input, run, content rows, approval_request, audit chain. Each test
// below is one way two transactions could wait on each other if a path broke that order. A second connection
// holds one lock; the other transaction is started and the test waits (pg_stat_activity) until it is really
// blocked; then the holder takes the lock the blocked side would already hold in the wrong order. With the
// order kept, the holder gets it and both finish; with it broken, Postgres aborts one with a deadlock.

let stack: Stack
let jobs: JobsDeps
let brand: string
let adminId: string
let definitionId: string

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  registerSummaryHandlers(jobs.results, jobs)
  jobs.results.set('test.close', async (client, ctx) => {
    const { versionId } = ctx.result as { versionId: string }
    await moveState(client, jobs, versionId, 'superseded', { kind: 'system' })
    return { closed: versionId }
  })
  brand = await addBrand(stack, 'lock-order')
  adminId = await addUser(stack, {
    email: 'lo@example.test',
    password: 'x'.repeat(14),
    role: 'brand_admin',
    brandId: brand,
  })
  definitionId = await seedDefinition(stack.db)
}, 120_000)
afterAll(async () => {
  await stack?.close()
})

async function untilSomeoneWaitsOnALock(): Promise<void> {
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    const { rows } = await stack.db.admin.query(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    )
    if (rows[0].n > 0) return
    await sleep(25)
  }
  throw new Error('nothing started waiting on a lock')
}

async function holder(): Promise<PoolClient> {
  const client = await stack.db.admin.connect()
  await client.query('begin')
  return client
}
// Takes the lock a chain write needs, as any transaction writing an audit entry does.
const auditEntry = (client: PoolClient) =>
  client.query(
    `select audit.append($1::uuid, 'system'::app.actor_kind, null, 'test.holder', 'success', null, null)`,
    [brand],
  )

async function awaitingApproval(): Promise<string> {
  const item = (
    await stack.db.admin.query(
      `insert into app.content_item (brand_id, kind) values ($1, 'article') returning id`,
      [brand],
    )
  ).rows[0].id as string
  return withBrand(stack.appPool, brand, async (client) => {
    const created = await createVersion(client, jobs, {
      brandId: brand,
      contentItemId: item,
      payload: { kind: 'article', language: 'en', title: 'T', body: [{ type: 'paragraph', text: 'Hello' }] },
      createdBy: { kind: 'system' },
    })
    await moveState(client, jobs, created.versionId, 'in_checks', { kind: 'system' })
    await moveState(client, jobs, created.versionId, 'awaiting_approval', { kind: 'system' })
    return created.versionId
  })
}

describe('one lock order across release, the approvals tick and results', () => {
  it('the tick takes the brand row before its audit write: a holder of the brand row and then the chain does not deadlock it', async () => {
    await awaitingApproval()
    const clock = new ManualClock(new Date())
    // Each tick is two days on; reminders go out one per tick; the next tick is the overdue one (an audit write, then notifications).
    for (let i = 0; i < 10; i += 1) {
      const { rows } = await stack.db.admin.query(
        `select r.reminders_sent >= s.reminder_count as done from app.approval_request r
           join app.approval_setting s on s.brand_id = r.brand_id where r.brand_id = $1 and not r.overdue`,
        [brand],
      )
      if (rows.length > 0 && rows.every((r) => r.done)) break
      clock.advance(48 * 3_600_000)
      await tick(stack.appPool, { clock, audit: jobs.audit })
    }
    // A release holds the brand row, and writes its entry later.
    const holding = await holder()
    try {
      await holding.query('select 1 from app.brand where id = $1 for update', [brand])
      clock.advance(48 * 3_600_000)
      const ticking = tick(stack.appPool, { clock, audit: jobs.audit })
      await untilSomeoneWaitsOnALock()
      await auditEntry(holding)
      await holding.query('commit')
      const result = await ticking
      expect(result).toMatchObject({ failedBrands: 0 })
      expect(result.overdue).toBeGreaterThanOrEqual(1)
    } finally {
      await holding.query('rollback').catch(() => undefined)
      holding.release()
    }
  }, 60_000)

  it('a release applies a held result that closes an approval request: its own audit entry waits until after, so a holder of the request then the chain does not deadlock it', async () => {
    const versionId = await awaitingApproval()
    const jobId = await withBrand(stack.appPool, brand, async (client) => {
      const runId = await createRun(client, brand, {
        agent: 'closer',
        definitionVersionId: definitionId,
        startedByKind: 'system',
        startedById: null,
      })
      return createJob(client, jobs, brand, {
        runId,
        jobClass: 'interactive',
        input: {},
        expectedResultType: 'test.close',
      })
    })
    const claims = await claim(stack, jobs, jobId)
    await setSwitch(
      stack.appPool,
      { audit: jobs.audit },
      { brandId: brand, scope: 'brand', target: null, actor: adminId },
    )
    expect(await postResult(jobs, claims, { type: 'test.close', result: { versionId } })).toEqual({
      status: 'held',
    })
    const holding = await holder()
    try {
      await holding.query('select 1 from app.approval_request where content_version_id = $1 for update', [
        versionId,
      ])
      const releasing = releaseSwitch(
        stack.appPool,
        { audit: jobs.audit, afterRelease: releaseHeldJobs(jobs) },
        { brandId: brand, scope: 'brand', target: null, actor: adminId },
      ).then(
        (value) => value,
        (error: unknown) => error,
      )
      await untilSomeoneWaitsOnALock()
      await auditEntry(holding)
      await holding.query('commit')
      const released = await releasing
      expect(released).toMatchObject({ released: true })
    } finally {
      await holding.query('rollback').catch(() => undefined)
      holding.release()
    }
    const done = await stack.db.admin.query('select finished_at from app.job_input where job_id = $1', [
      jobId,
    ])
    expect(done.rows[0].finished_at).not.toBeNull()
    const state = await stack.db.admin.query(
      'select state from app.content_version_state where content_version_id = $1',
      [versionId],
    )
    expect(state.rows[0].state).toBe('superseded')
  }, 60_000)

  it('a decision on a brief takes the brand row before the onboarding row: a release that holds the brand row and then applies a held strategist result does not deadlock it', async () => {
    await stack.db.admin.query(
      `insert into app.onboarding (brand_id, step) values ($1, 'brief') on conflict (brand_id) do nothing`,
      [brand],
    )
    const item = (
      await stack.db.admin.query(
        `insert into app.content_item (brand_id, kind) values ($1, 'strategy_brief') returning id`,
        [brand],
      )
    ).rows[0].id as string
    const version = await withBrand(stack.appPool, brand, async (client) => {
      const created = await createVersion(client, jobs, {
        brandId: brand,
        contentItemId: item,
        payload: { kind: 'strategy_brief', language: 'en', body: [{ type: 'paragraph', text: 'Shine.' }] },
        createdBy: { kind: 'system' },
      })
      await moveState(client, jobs, created.versionId, 'in_checks', { kind: 'system' })
      await moveState(client, jobs, created.versionId, 'awaiting_approval', { kind: 'system' })
      return created
    })
    const holding = await holder()
    try {
      // A release holds the brand row; applying the held brief result then takes the onboarding row.
      await holding.query('select 1 from app.brand where id = $1 for update', [brand])
      const deciding = approve(stack.appPool, jobs, {
        brandId: brand,
        itemId: item,
        versionId: version.versionId,
        actor: { kind: 'user', userId: adminId },
        role: 'platform_owner',
        hash: version.hash,
        scheme: 'cv1',
      }).then(
        (value) => value,
        (error: unknown) => error,
      )
      await untilSomeoneWaitsOnALock()
      await holding.query('select 1 from app.onboarding where brand_id = $1 for update', [brand])
      await holding.query('commit')
      expect(await deciding).toMatchObject({ approvalId: expect.any(String) })
    } finally {
      await holding.query('rollback').catch(() => undefined)
      holding.release()
    }
  }, 60_000)

  // A brand at the brief with one fact in force, and a brief waiting for approval that cites it.
  async function briefCitingAFact(
    slug: string,
  ): Promise<{ brandId: string; factId: string; versionId: string }> {
    const brandId = await addBrand(stack, slug)
    await stack.db.admin.query(`insert into app.onboarding (brand_id, step) values ($1, 'brief')`, [brandId])
    const statement = 'Open since 2019.'
    const fact = (
      await stack.db.admin.query(
        `insert into app.verified_fact (brand_id, statement, fact_hash, source_ids, confirmed_by, review_date)
         values ($1, $2, $3, '{}', $4, current_date + 90) returning id`,
        [brandId, statement, factHash(statement), adminId],
      )
    ).rows[0].id as string
    const item = (
      await stack.db.admin.query(
        `insert into app.content_item (brand_id, kind) values ($1, 'strategy_brief') returning id`,
        [brandId],
      )
    ).rows[0].id as string
    const versionId = await withBrand(stack.appPool, brandId, async (client) => {
      const created = await createVersion(client, jobs, {
        brandId,
        contentItemId: item,
        payload: {
          kind: 'strategy_brief',
          language: 'en',
          body: [{ type: 'paragraph', text: 'Shine.' }],
          fact_refs: [{ fact_id: fact, text_hash: `sha256:${factHash(statement)}` }],
        },
        createdBy: { kind: 'system' },
      })
      await moveState(client, jobs, created.versionId, 'in_checks', { kind: 'system' })
      await moveState(client, jobs, created.versionId, 'awaiting_approval', { kind: 'system' })
      return created.versionId
    })
    return { brandId, factId: fact, versionId }
  }

  // A release holds the brand row; applying a held result then takes the onboarding row, which a fact change holds
  // unless it waited for the brand row first.
  async function againstARelease(brandId: string, change: () => Promise<unknown>): Promise<unknown> {
    const holding = await holder()
    try {
      await holding.query('select 1 from app.brand where id = $1 for update', [brandId])
      const changing = change().then(
        (value) => value,
        (error: unknown) => error,
      )
      await untilSomeoneWaitsOnALock()
      await holding.query('select 1 from app.onboarding where brand_id = $1 for update', [brandId])
      await holding.query('commit')
      return await changing
    } finally {
      await holding.query('rollback').catch(() => undefined)
      holding.release()
    }
  }
  const stateOf = async (versionId: string) =>
    (
      await stack.db.admin.query(
        'select state from app.content_version_state where content_version_id = $1',
        [versionId],
      )
    ).rows[0].state as string

  it('a fact change takes the brand row before the onboarding row: replacing a fact does not deadlock a release that applies a held result', async () => {
    const made = await briefCitingAFact('lock-order-replace')
    const replaced = await againstARelease(made.brandId, () =>
      replaceFact(stack.appPool, jobs, {
        brandId: made.brandId,
        factId: made.factId,
        statement: 'Open since 2018.',
        reviewDate: '2027-06-30',
        actor: { userId: adminId },
      }),
    )
    expect(replaced).toMatchObject({ factId: expect.any(String) })
    expect(await stateOf(made.versionId)).toBe('invalidated')
  }, 60_000)

  it('a fact change takes the brand row before the onboarding row: retiring a fact does not deadlock a release that applies a held result', async () => {
    const made = await briefCitingAFact('lock-order-retire')
    const retired = await againstARelease(made.brandId, () =>
      retireFact(stack.appPool, jobs, {
        brandId: made.brandId,
        factId: made.factId,
        actor: { userId: adminId },
      }),
    )
    expect(retired).toEqual({ factId: made.factId })
    expect(await stateOf(made.versionId)).toBe('invalidated')
  }, 60_000)

  it('a result post takes the brand row before the job row: a holder of the brand row that then wants the job row does not deadlock it', async () => {
    const { jobId } = await startRun(jobs, brand, adminId, BRIEF)
    const claims = await claim(stack, jobs, jobId)
    const holding = await holder()
    try {
      await holding.query('select 1 from app.brand where id = $1 for update', [brand])
      const posting = postResult(jobs, claims, { type: 'summary.v1', result: GOOD_RESULT }).then(
        (value) => value,
        (error: unknown) => error,
      )
      await untilSomeoneWaitsOnALock()
      await holding.query('select 1 from app.job_input where job_id = $1 for update', [jobId])
      await holding.query('commit')
      expect(await posting).toMatchObject({ status: 'applied' })
    } finally {
      await holding.query('rollback').catch(() => undefined)
      holding.release()
    }
  }, 60_000)
})
