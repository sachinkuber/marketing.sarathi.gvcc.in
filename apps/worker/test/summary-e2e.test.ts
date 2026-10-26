import { prepareVersion } from '@mkt/canonical'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PAYLOAD_SCHEMA, summaryPayload } from '@mkt/shared'
import { sleep } from '@mkt/test-support'
import { listDead } from '../../core/src/jobs/dead.ts'
import type { JobsDeps } from '../../core/src/jobs/service.ts'
import { registerSummaryHandlers } from '../../core/src/agents/register.ts'
import { startSummaryRun } from '../../core/src/agents/start.ts'
import { BRIEF, GOOD_RESULT } from '../../core/test/summary-support.ts'
import {
  addBrand,
  addUser,
  createStack,
  enrolledClient,
  type Stack,
  type TestClient,
} from '../../core/test/support.ts'
import { checkHandler } from '../src/agents/check.ts'
import { summaryHandler } from '../src/agents/summary.ts'
import { httpCoreClient } from '../src/core-client.ts'
import { startWorker } from '../src/main.ts'
import { standInModel } from '../src/standin.ts'

const PASSWORD = 'correct horse battery'

let stack: Stack
let jobs: JobsDeps
let worker: { stop(): Promise<void> }
let owner: TestClient
let approver: TestClient
let reply = JSON.stringify(GOOD_RESULT)

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('the stack has no queue')
  jobs = stack.jobs
  // The stack's job table starts empty; production fills it in startServer with these same handlers.
  registerSummaryHandlers(jobs.results, jobs)
  // Test prices and a rate dated from the service's own clock (the worker talks to the real HTTP server).
  const today = jobs.now().toISOString().slice(0, 10)
  await stack.db.admin.query(
    `insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, source)
     values ('claude-opus-5-5', $1::date - 30, 4000000, 20000000, 200000, 5000000, 'test')`,
    [today],
  )
  await stack.db.admin.query(`select app.record_fx_rate($1::date - 1, 83500000, 'test')`, [today])
  worker = await startWorker({
    core: httpCoreClient(stack.server.url, jobs.workerSecret),
    model: standInModel({ logFile: '/dev/null', replyFor: () => reply }),
    handlers: { 'summary.v1': summaryHandler, 'placeholder_check.v1': checkHandler },
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

const q = async (sql: string, params: unknown[] = []) => (await stack.db.admin.query(sql, params)).rows

describe('acceptance test 37', () => {
  it('a brief goes in and an approved summary comes out, through the worker, with its cost and its audit trail', async () => {
    const brand = await addBrand(stack, 'e2e-ok')
    const ownerId = await addUser(stack, { email: 'o@e2e.test', password: PASSWORD, platformOwner: true })
    const approverId = await addUser(stack, {
      email: 'ap@e2e.test',
      password: PASSWORD,
      role: 'approver',
      brandId: brand,
    })
    const adminId = await addUser(stack, {
      email: 'ad@e2e.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brand,
    })
    owner = (await enrolledClient(stack, 'o@e2e.test', PASSWORD)).client
    approver = (await enrolledClient(stack, 'ap@e2e.test', PASSWORD)).client

    const started = await owner.request('POST', `/api/v1/brands/${brand}/agents/summary/runs`, {
      body: { brief: BRIEF },
    })
    expect(started.status).toBe(201)
    const { runId } = started.json as { runId: string; jobId: string }

    await until(
      async () => (await q('select state from app.run where id = $1', [runId]))[0].state !== 'running',
      60_000,
    )
    expect((await q('select state from app.run where id = $1', [runId]))[0].state).toBe('succeeded')

    // One model call, succeeded, with its token counts; one cost row in both currencies and the rate id.
    const calls = await q(
      `select id, step, status, model, input_tokens, output_tokens, charged_currency, usd_micros, inr_micros, fx_rate_id
         from app.model_call where run_id = $1`,
      [runId],
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      step: 'summarise',
      status: 'succeeded',
      model: 'claude-opus-5-5',
      input_tokens: 1000,
      output_tokens: 500,
      charged_currency: 'USD',
      usd_micros: '14000',
      inr_micros: '1169000',
    })
    const ledger = await q(
      'select usd_micros, inr_micros, charged_micros, charged_currency, fx_rate_id, run_id from app.cost_ledger where model_call_id = $1',
      [calls[0].id],
    )
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      usd_micros: '14000',
      inr_micros: '1169000',
      charged_micros: '14000',
      charged_currency: 'USD',
      run_id: runId,
    })
    expect(ledger[0].fx_rate_id).toBe(calls[0].fx_rate_id)
    expect(ledger[0].fx_rate_id).not.toBeNull()

    // Two jobs (summary, then check), one attempt each, none left active.
    const inputs = await q(
      'select expected_result_type from app.job_input where run_id = $1 order by created_at',
      [runId],
    )
    expect(inputs.map((r) => r.expected_result_type)).toEqual(['summary.v1', 'placeholder_check.v1'])
    const attempts = await q(
      `select a.job_id, a.state from app.job_attempt a join app.job_input j on j.job_id = a.job_id where j.run_id = $1`,
      [runId],
    )
    expect(attempts).toHaveLength(2)
    expect(new Set(attempts.map((a) => a.job_id)).size).toBe(2)
    expect(attempts.every((a) => a.state !== 'active')).toBe(true)

    // Version 1, with the hash the canonical form gives, waiting for approval.
    const items = await q('select id, kind, current_version_id from app.content_item where brand_id = $1', [
      brand,
    ])
    expect(items).toHaveLength(1)
    const itemId = items[0].id as string
    const versions = await q('select id, number, hash from app.content_version where brand_id = $1', [brand])
    expect(versions).toHaveLength(1)
    const version = versions[0]
    const expected = prepareVersion({
      ...summaryPayload(GOOD_RESULT),
      schema: PAYLOAD_SCHEMA,
      brand_id: brand,
      content_item_id: itemId,
    })
    expect(version.number).toBe(1)
    expect(version.hash).toBe(expected.hash)
    const stateOf = async () =>
      (await q('select state from app.content_version_state where content_version_id = $1', [version.id]))[0]
        .state
    expect(await stateOf()).toBe('awaiting_approval')

    // One queued notification for each approver of the brand.
    const told = await q(
      `select user_id, state from app.notification where subject_id = $1 and kind = 'approval_waiting' order by user_id`,
      [version.id],
    )
    expect(told.map((r) => r.user_id)).toEqual([adminId, approverId].sort())
    expect(told.every((r) => r.state === 'queued')).toBe(true)

    // Approving with the hash that was shown.
    const approved = await approver.request(
      'POST',
      `/api/v1/brands/${brand}/content/${itemId}/versions/${version.id}/approve`,
      { body: { hash: version.hash, hash_scheme: 'cv1' } },
    )
    expect(approved.status).toBe(201)
    expect(await stateOf()).toBe('approved')
    const outbox = await q('select kind, state from app.outbox_action where content_version_id = $1', [
      version.id,
    ])
    expect(outbox).toHaveLength(1)

    // The brand's audit chain tells the whole story, in order, and verifies.
    const story = [
      'agent.run_started',
      'content.version_created',
      'content.state_changed',
      'approval.approved',
    ]
    const chain = await q(
      `select action, outcome, detail from audit.log where chain_key = $1 and action = any($2) order by seq`,
      [brand, story],
    )
    expect(chain.map((r) => r.action)).toEqual([
      'agent.run_started',
      'content.version_created',
      'content.state_changed',
      'content.state_changed',
      // The approval itself also moves the state (awaiting_approval to approved) just before it is recorded.
      'content.state_changed',
      'approval.approved',
    ])
    expect(chain.every((r) => r.outcome === 'success')).toBe(true)
    expect(chain[2].detail).toMatchObject({ from: 'draft', to: 'in_checks' })
    expect(chain[3].detail).toMatchObject({ from: 'in_checks', to: 'awaiting_approval' })
    expect(chain[4].detail).toMatchObject({ from: 'awaiting_approval', to: 'approved' })
    expect(chain[0].detail).toMatchObject({ runId })
    expect((await q('select ok from audit.verify_chain($1)', [brand]))[0].ok).toBe(true)
    expect(ownerId).toBeTruthy()
  }, 180_000)

  it('a reply that is not a valid summary is retried, then dead-lettered, and never becomes content', async () => {
    const brand = await addBrand(stack, 'e2e-bad')
    const ownerId = (await q(`select user_id from app.platform_owner limit 1`))[0].user_id as string
    reply = JSON.stringify({ summary: 'Fine.', keywords: ['a', 'b', 'c', 'd'] })
    const { runId, jobId } = await startSummaryRun(jobs.pool, jobs, {
      brandId: brand,
      brief: BRIEF,
      actor: { userId: ownerId },
    })

    // Three attempts (retry limit 2, plus the first), then the library gives up and the core marks it.
    await until(async () => (await listDead(jobs, brand)).some((j) => j.jobId === jobId), 150_000)
    const attempts = await q('select state from app.job_attempt where job_id = $1', [jobId])
    expect(attempts).toHaveLength(3)
    expect(attempts.every((a) => a.state !== 'active')).toBe(true)
    expect((await q('select state from app.run where id = $1', [runId]))[0].state).toBe('failed')

    // The model was asked once (the saved step is reused by the retries) and was paid for; nothing was made.
    expect(await q('select status from app.model_call where run_id = $1', [runId])).toEqual([
      { status: 'succeeded' },
    ])
    expect(
      (await q('select count(*)::int as n from app.content_item where brand_id = $1', [brand]))[0].n,
    ).toBe(0)
    expect(
      (await q('select count(*)::int as n from app.content_version where brand_id = $1', [brand]))[0].n,
    ).toBe(0)
    expect(
      (
        await q(
          `select count(*)::int as n from app.job_input where run_id = $1 and expected_result_type = 'placeholder_check.v1'`,
          [runId],
        )
      )[0].n,
    ).toBe(0)
    expect((await q('select count(*)::int as n from app.job_input where run_id = $1', [runId]))[0].n).toBe(1)
    expect((await q('select ok from audit.verify_chain($1)', [brand]))[0].ok).toBe(true)
  }, 300_000)
})
