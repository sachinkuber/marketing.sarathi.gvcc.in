import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import type { JobsDeps } from '../src/jobs/service.ts'
import {
  createJob,
  createRun,
  registerModelCall,
  saveCheckpoint,
  startAttempt,
  failModelCall,
} from '../src/jobs/service.ts'
import { verifyAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'
import { addBrand, createStack, type Stack } from './support.ts'

let stack: Stack
let jobs: JobsDeps
let brand: string
let definitionId: string

const USAGE = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }

async function startedJob(): Promise<{ jobId: string; claims: AttemptClaims; token: string }> {
  const jobId = await withBrand(stack.appPool, brand, async (client) => {
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
      expectedResultType: 'test.echo',
    })
  })
  await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
    jobId,
  ])
  const started = await startAttempt(jobs, jobId, 'w1')
  if (started.finished) throw new Error('unexpected')
  const check = verifyAttemptToken(
    jobs.attemptTokenSecret,
    started.token,
    Math.floor(jobs.now().getTime() / 1000),
  )
  if (!check.ok) throw new Error('token')
  return { jobId, claims: check.claims, token: started.token }
}

async function reattempt(jobId: string): Promise<AttemptClaims> {
  const started = await startAttempt(jobs, jobId, 'w2')
  if (started.finished) throw new Error('unexpected')
  const check = verifyAttemptToken(
    jobs.attemptTokenSecret,
    started.token,
    Math.floor(jobs.now().getTime() / 1000),
  )
  if (!check.ok) throw new Error('token')
  return check.claims
}

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  brand = await addBrand(stack, 'model-calls')
  definitionId = await seedDefinition(stack.db)
  // Dates are relative to the service's own clock, so "today has no rate" is true by construction.
  const today = jobs.now().toISOString().slice(0, 10)
  await stack.db.admin.query(
    `insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, source)
     values ('test-model', $1::date - 30, 4000000, 20000000, 200000, 5000000, 'test')`,
    [today],
  )
  await stack.db.admin.query(`select app.record_fx_rate($1::date - 2, 83500000, 'test')`, [today])
})
afterAll(async () => {
  await stack?.close()
})

describe('the model-call ledger and the cost ledger', () => {
  it('writes the call before it is sent, then the checkpoint and the cost in both currencies', async () => {
    const { claims } = await startedJob()
    const reg = await registerModelCall(jobs, claims, {
      step: 'draft',
      requestHash: 'h1',
      model: 'test-model',
    })
    expect(reg).toMatchObject({ outcome: 'send', possibleDuplicate: false })
    if (reg.outcome !== 'send') return

    const before = await stack.db.admin.query('select status, usd_micros from app.model_call where id = $1', [
      reg.callId,
    ])
    expect(before.rows[0]).toEqual({ status: 'started', usd_micros: null })

    const saved = await saveCheckpoint(jobs, claims, {
      callId: reg.callId,
      step: 'draft',
      output: { text: 'hello' },
      model: 'test-model',
      providerMessageId: 'msg_1',
      providerRequestId: 'req_1',
      usage: USAGE,
    })
    expect(saved).toEqual({ costed: true })

    const call = await stack.db.admin.query(
      `select status, provider_message_id, input_tokens, output_tokens, charged_micros, charged_currency, usd_micros, inr_micros, fx_rate_id
         from app.model_call where id = $1`,
      [reg.callId],
    )
    expect(call.rows[0]).toMatchObject({
      status: 'succeeded',
      provider_message_id: 'msg_1',
      input_tokens: 1000,
      output_tokens: 500,
      charged_currency: 'USD',
      usd_micros: '14000',
      inr_micros: '1169000',
    })
    const ledger = await stack.db.admin.query(
      'select usd_micros, inr_micros, charged_micros, fx_rate_id from app.cost_ledger where model_call_id = $1',
      [reg.callId],
    )
    expect(ledger.rows).toHaveLength(1)
    expect(ledger.rows[0]).toMatchObject({
      usd_micros: '14000',
      inr_micros: '1169000',
      charged_micros: '14000',
    })
    expect(ledger.rows[0].fx_rate_id).toBe(call.rows[0].fx_rate_id)
  })

  it('uses the saved checkpoint and sends nothing for a step already done, even from a later attempt', async () => {
    const { jobId, claims } = await startedJob()
    const reg = await registerModelCall(jobs, claims, {
      step: 'outline',
      requestHash: 'same',
      model: 'test-model',
    })
    if (reg.outcome !== 'send') throw new Error('unexpected')
    await saveCheckpoint(jobs, claims, {
      callId: reg.callId,
      step: 'outline',
      output: { points: 3 },
      model: 'test-model',
      providerMessageId: 'msg_2',
      providerRequestId: null,
      usage: USAGE,
    })
    const later = await reattempt(jobId)
    const again = await registerModelCall(jobs, later, {
      step: 'outline',
      requestHash: 'same',
      model: 'test-model',
    })
    expect(again).toEqual({ outcome: 'use_checkpoint', output: { points: 3 } })
    const count = await stack.db.admin.query(
      'select count(*)::int as n from app.model_call where job_id = $1',
      [jobId],
    )
    expect(count.rows[0].n).toBe(1)
  })

  it('test 25: a call with no outcome from an earlier attempt flags the new call as a possible duplicate, and both are in the ledger', async () => {
    const { jobId, claims } = await startedJob()
    const first = await registerModelCall(jobs, claims, {
      step: 'final',
      requestHash: 'x',
      model: 'test-model',
    })
    expect(first.outcome).toBe('send')
    // The worker is killed after the provider replied and before the checkpoint: nothing more is recorded.
    const later = await reattempt(jobId)
    const second = await registerModelCall(jobs, later, {
      step: 'final',
      requestHash: 'x',
      model: 'test-model',
    })
    expect(second).toMatchObject({ outcome: 'send', possibleDuplicate: true })
    if (second.outcome !== 'send') return
    await saveCheckpoint(jobs, later, {
      callId: second.callId,
      step: 'final',
      output: { ok: true },
      model: 'test-model',
      providerMessageId: 'msg_3',
      providerRequestId: null,
      usage: USAGE,
    })
    const rows = await stack.db.admin.query(
      'select status, possible_duplicate from app.model_call where job_id = $1 order by started_at',
      [jobId],
    )
    expect(rows.rows).toEqual([
      { status: 'started', possible_duplicate: false },
      { status: 'succeeded', possible_duplicate: true },
    ])
    const costs = await stack.db.admin.query(
      'select count(*)::int as n from app.cost_ledger c join app.model_call m on m.id = c.model_call_id where m.job_id = $1',
      [jobId],
    )
    expect(costs.rows[0].n).toBe(1)
  })

  it('refuses a checkpoint from an attempt that was replaced', async () => {
    const { jobId, claims } = await startedJob()
    const reg = await registerModelCall(jobs, claims, { step: 's', requestHash: 'y', model: 'test-model' })
    if (reg.outcome !== 'send') throw new Error('unexpected')
    await reattempt(jobId)
    await expect(
      saveCheckpoint(jobs, claims, {
        callId: reg.callId,
        step: 's',
        output: {},
        model: 'test-model',
        providerMessageId: 'm',
        providerRequestId: null,
        usage: USAGE,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'attempt_refused' })
  })

  it('saves the same checkpoint twice without a second cost row', async () => {
    const { claims } = await startedJob()
    const reg = await registerModelCall(jobs, claims, {
      step: 'twice',
      requestHash: 'z',
      model: 'test-model',
    })
    if (reg.outcome !== 'send') throw new Error('unexpected')
    const input = {
      callId: reg.callId,
      step: 'twice',
      output: { a: 1 },
      model: 'test-model',
      providerMessageId: 'msg_4',
      providerRequestId: null,
      usage: USAGE,
    }
    await saveCheckpoint(jobs, claims, input)
    await expect(saveCheckpoint(jobs, claims, input)).resolves.toEqual({ costed: true })
    const n = await stack.db.admin.query(
      'select count(*)::int as n from app.cost_ledger where model_call_id = $1',
      [reg.callId],
    )
    expect(n.rows[0].n).toBe(1)
  })

  it('never loses the call or blocks the checkpoint when the model has no price', async () => {
    const { claims } = await startedJob()
    const reg = await registerModelCall(jobs, claims, {
      step: 'noprice',
      requestHash: 'p',
      model: 'unpriced-model',
    })
    if (reg.outcome !== 'send') throw new Error('unexpected')
    const saved = await saveCheckpoint(jobs, claims, {
      callId: reg.callId,
      step: 'noprice',
      output: { a: 1 },
      model: 'unpriced-model',
      providerMessageId: 'msg_5',
      providerRequestId: null,
      usage: USAGE,
    })
    expect(saved).toEqual({ costed: false })
    const row = await stack.db.admin.query(
      'select status, usd_micros, input_tokens from app.model_call where id = $1',
      [reg.callId],
    )
    expect(row.rows[0]).toEqual({ status: 'succeeded', usd_micros: null, input_tokens: 1000 })
    const n = await stack.db.admin.query(
      'select count(*)::int as n from app.cost_ledger where model_call_id = $1',
      [reg.callId],
    )
    expect(n.rows[0].n).toBe(0)
  })

  it('uses the most recent earlier rate when today has none, and says which', async () => {
    const { claims } = await startedJob()
    const reg = await registerModelCall(jobs, claims, { step: 'rate', requestHash: 'r', model: 'test-model' })
    if (reg.outcome !== 'send') throw new Error('unexpected')
    await saveCheckpoint(jobs, claims, {
      callId: reg.callId,
      step: 'rate',
      output: {},
      model: 'test-model',
      providerMessageId: 'msg_6',
      providerRequestId: null,
      usage: USAGE,
    })
    const row = await stack.db.admin.query(
      `select f.rate_date::text as rate_date, f.rate_micros::text as rate from app.model_call m join app.fx_rate f on f.id = m.fx_rate_id where m.id = $1`,
      [reg.callId],
    )
    expect(row.rows[0].rate).toBe('83500000')
    expect(row.rows[0].rate_date).toBe(
      new Date(jobs.now().getTime() - 2 * 86400000).toISOString().slice(0, 10),
    )
  })

  it('records a failed request with its error and leaves no cost', async () => {
    const { claims } = await startedJob()
    const reg = await registerModelCall(jobs, claims, { step: 'fail', requestHash: 'f', model: 'test-model' })
    if (reg.outcome !== 'send') throw new Error('unexpected')
    await failModelCall(jobs, claims, reg.callId, 'provider 529 overloaded')
    const row = await stack.db.admin.query('select status, error from app.model_call where id = $1', [
      reg.callId,
    ])
    expect(row.rows[0]).toEqual({ status: 'failed', error: 'provider 529 overloaded' })
  })

  it('answers cancelled or held before a call is sent, and writes no call row', async () => {
    const { jobId, claims } = await startedJob()
    await stack.db.admin.query('update app.job_control set held = true where job_id = $1', [jobId])
    expect(
      await registerModelCall(jobs, claims, { step: 'h', requestHash: 'h', model: 'test-model' }),
    ).toEqual({ outcome: 'held' })
    await stack.db.admin.query(
      'update app.job_control set held = false, cancel_requested = true where job_id = $1',
      [jobId],
    )
    expect(
      await registerModelCall(jobs, claims, { step: 'h', requestHash: 'h', model: 'test-model' }),
    ).toEqual({ outcome: 'cancelled' })
    const n = await stack.db.admin.query('select count(*)::int as n from app.model_call where job_id = $1', [
      jobId,
    ])
    expect(n.rows[0].n).toBe(0)
  })
})

describe('the model-call routes', () => {
  async function post(path: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${stack.server.url}/api/v1${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Worker ${jobs.workerSecret}`,
        'x-attempt-token': token,
      },
      body: JSON.stringify(body),
    })
  }

  it('accepts a 200 kB checkpoint output, while another worker route still stops at 100 kB', async () => {
    const { jobId, token } = await startedJob()
    const reg = await post(`/worker/jobs/${jobId}/model-calls`, token, {
      step: 'big',
      requestHash: 'b',
      model: 'test-model',
    })
    expect(reg.status).toBe(200)
    const { callId } = (await reg.json()) as { callId: string }

    const big = { text: 'x'.repeat(200_000) }
    const saved = await post(`/worker/jobs/${jobId}/model-calls/${callId}/checkpoint`, token, {
      step: 'big',
      output: big,
      model: 'test-model',
      providerMessageId: 'msg_big',
      providerRequestId: null,
      usage: USAGE,
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ costed: true })

    const again = await post(`/worker/jobs/${jobId}/model-calls`, token, {
      step: 'big',
      requestHash: 'b',
      model: 'test-model',
    })
    expect(await again.json()).toEqual({ outcome: 'use_checkpoint', output: big })

    const tooBig = await post(`/worker/jobs/${jobId}/model-calls`, token, {
      step: 'x'.repeat(200_000),
      requestHash: 'b',
      model: 'test-model',
    })
    expect(tooBig.status).toBe(413)
  })

  it('answers 204 to a failure and refuses an unknown body field', async () => {
    const { jobId, claims, token } = await startedJob()
    const reg = await registerModelCall(jobs, claims, { step: 'f2', requestHash: 'f2', model: 'test-model' })
    if (reg.outcome !== 'send') throw new Error('unexpected')
    const path = `/worker/jobs/${jobId}/model-calls/${reg.callId}/failure`
    expect((await post(path, token, { error: 'boom', more: 1 })).status).toBe(400)
    expect((await post(path, token, { error: 'boom' })).status).toBe(204)
    const row = await stack.db.admin.query('select status from app.model_call where id = $1', [reg.callId])
    expect(row.rows[0].status).toBe('failed')
  })
})
