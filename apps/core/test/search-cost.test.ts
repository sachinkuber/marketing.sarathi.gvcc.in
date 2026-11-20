import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import type { JobsDeps } from '../src/jobs/service.ts'
import { createJob, createRun, registerModelCall, saveCheckpoint, startAttempt } from '../src/jobs/service.ts'
import { verifyAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'
import { addBrand, createStack, type Stack } from './support.ts'

let stack: Stack
let jobs: JobsDeps
let brand: string
let definitionId: string

const USAGE = {
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  serverToolSearches: 0,
  serverToolFetches: 0,
}

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
  if (started.finished || 'outcome' in started) throw new Error('unexpected')
  const check = verifyAttemptToken(
    jobs.attemptTokenSecret,
    started.token,
    Math.floor(jobs.now().getTime() / 1000),
  )
  if (!check.ok) throw new Error('token')
  return { jobId, claims: check.claims, token: started.token }
}

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  brand = await addBrand(stack, 'search-cost')
  definitionId = await seedDefinition(stack.db)
  // Dates are relative to the service's own clock, so "today has no rate" is true by construction.
  const today = jobs.now().toISOString().slice(0, 10)
  // Tokens 4 / 20 USD per million, 10000 micro-USD per search; a second model has no search price.
  await stack.db.admin.query(
    `insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, search_micros, source)
     values ('search-model', $1::date - 30, 4000000, 20000000, 200000, 5000000, 10000, 'test'),
            ('nosearch-model', $1::date - 30, 4000000, 20000000, 200000, 5000000, null, 'test')`,
    [today],
  )
  await stack.db.admin.query(`select app.record_fx_rate($1::date - 2, 83500000, 'test')`, [today])
})
afterAll(async () => {
  await stack?.close()
})

async function checkpoint(
  model: string,
  usage: typeof USAGE,
): Promise<{ callId: string; saved: { costed: boolean } }> {
  const { claims } = await startedJob()
  const step = `s-${Math.random().toString(36).slice(2, 8)}`
  const reg = await registerModelCall(jobs, claims, { step, requestHash: 'h', model })
  if (reg.outcome !== 'send') throw new Error('unexpected')
  const saved = await saveCheckpoint(jobs, claims, {
    callId: reg.callId,
    step,
    output: { text: 'x' },
    model,
    providerMessageId: 'msg',
    providerRequestId: null,
    usage,
  })
  return { callId: reg.callId, saved }
}

async function row(callId: string) {
  const call = await stack.db.admin.query(
    `select server_tool_searches, server_tool_fetches, usd_micros::text, inr_micros::text, charged_micros::text
       from app.model_call where id = $1`,
    [callId],
  )
  const ledger = await stack.db.admin.query(
    'select usd_micros::text, inr_micros::text from app.cost_ledger where model_call_id = $1',
    [callId],
  )
  return { call: call.rows[0], ledger: ledger.rows }
}

describe('web searches recorded and costed (spec test 50)', () => {
  it('a call with 7 searches costs its tokens plus 70000 micro-USD, and INR at the day rate', async () => {
    const { callId, saved } = await checkpoint('search-model', { ...USAGE, serverToolSearches: 7 })
    expect(saved).toEqual({ costed: true })
    const { call, ledger } = await row(callId)
    // Tokens: (1000 * 4000000 + 500 * 20000000) / 1e6 = 4000 + 10000 = 14000. Searches: 7 * 10000 = 70000.
    // USD = 84000 micro-USD. INR = 84000 * 83500000 / 1e6 = 7014000 micro-INR.
    expect(call).toMatchObject({
      server_tool_searches: 7,
      server_tool_fetches: 0,
      usd_micros: '84000',
      charged_micros: '84000',
      inr_micros: '7014000',
    })
    expect(ledger).toEqual([{ usd_micros: '84000', inr_micros: '7014000' }])
  })

  it('fetches are counted but not charged', async () => {
    const { callId, saved } = await checkpoint('search-model', { ...USAGE, serverToolFetches: 5 })
    expect(saved).toEqual({ costed: true })
    const { call } = await row(callId)
    // Tokens only: 14000 micro-USD; INR = 14000 * 83.5 = 1169000.
    expect(call).toMatchObject({
      server_tool_searches: 0,
      server_tool_fetches: 5,
      usd_micros: '14000',
      inr_micros: '1169000',
    })
  })

  it('searches with no search price leave the call uncosted', async () => {
    const { callId, saved } = await checkpoint('nosearch-model', { ...USAGE, serverToolSearches: 3 })
    expect(saved).toEqual({ costed: false })
    const { call, ledger } = await row(callId)
    expect(call).toMatchObject({
      server_tool_searches: 3,
      usd_micros: null,
      inr_micros: null,
      charged_micros: null,
    })
    expect(ledger).toEqual([])
  })

  it('negative counts are refused 400, and absent counts default to 0', async () => {
    const { jobId, claims, token } = await startedJob()
    const send = async (step: string, usage: Record<string, unknown>) => {
      const reg = await registerModelCall(jobs, claims, { step, requestHash: 'h', model: 'search-model' })
      if (reg.outcome !== 'send') throw new Error('unexpected')
      const res = await fetch(
        `${stack.server.url}/api/v1/worker/jobs/${jobId}/model-calls/${reg.callId}/checkpoint`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Worker ${jobs.workerSecret}`,
            'x-attempt-token': token,
          },
          body: JSON.stringify({
            step,
            output: {},
            model: 'search-model',
            providerMessageId: 'm',
            providerRequestId: null,
            usage,
          }),
        },
      )
      return { res, callId: reg.callId }
    }
    const base = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }
    expect((await send('neg1', { ...base, serverToolSearches: -1 })).res.status).toBe(400)
    expect((await send('neg2', { ...base, serverToolFetches: -1 })).res.status).toBe(400)
    expect((await send('frac', { ...base, serverToolSearches: 1.5 })).res.status).toBe(400)
    const old = await send('old', base)
    expect(old.res.status).toBe(200)
    expect((await row(old.callId)).call).toMatchObject({
      server_tool_searches: 0,
      server_tool_fetches: 0,
      usd_micros: '14000',
    })
  })
})
