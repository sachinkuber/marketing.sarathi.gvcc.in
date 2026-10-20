import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agentsReply,
  auditReply,
  auditVerifyReply,
  homeReply,
  modelCallReviewReply,
  runDetailReply,
  runsReply,
  statusReply,
} from '../../dashboard/src/api/schemas.ts'
import {
  api,
  cast,
  readsStack,
  seedAwaiting,
  seedCall,
  seedJob,
  seedRun,
  NOW,
  type Cast,
} from './reads-support.ts'
import type { Stack } from './support.ts'

// The dashboard parses every reply with the schema of the same name; the core's real replies must satisfy them.
let stack: Stack
let c: Cast
let runId: string

beforeAll(async () => {
  stack = await readsStack()
  c = await cast(stack)
  runId = await seedRun(stack, c.brandId, { usd: 2_000_000n, inr: 166_000_000n })
  await seedRun(stack, c.brandId, { state: 'running' })
  await seedJob(stack, c.brandId, runId, { finished: true, attempts: ['failed', 'succeeded'] })
  await seedJob(stack, c.brandId, runId, { dead: true, attempts: ['failed'] })
  await seedCall(stack, c.brandId, runId, { status: 'unknown' })
  await seedCall(stack, c.brandId, runId)
  await seedAwaiting(stack, c.brandId, new Date(NOW.getTime() - 3_600_000))
  await stack.auditPool!.query(
    `select audit.append($1::uuid, 'system', null, 'test.run_event', 'success', $2, '{"k":1}'::jsonb)`,
    [c.brandId, runId],
  )
})
afterAll(async () => stack?.close())

const get = async (who: 'admin' | 'owner' | 'approver' | 'viewer', path: string) => {
  const reply = await c[who].request('GET', path)
  expect(reply.status, path).toBe(200)
  return reply.json
}

describe('the dashboard schemas accept the core’s replies', () => {
  it('status', async () => {
    for (const who of ['admin', 'viewer'] as const) {
      statusReply.parse(await get(who, api(c.brandId, '/status')))
    }
  })
  it('home, for every kind of reader', async () => {
    for (const who of ['admin', 'owner', 'approver', 'viewer'] as const) {
      homeReply.parse(await get(who, api(c.brandId, '/home')))
    }
  })
  it('agents', async () => {
    agentsReply.parse(await get('admin', api(c.brandId, '/agents')))
  })
  it('runs, and the same with a cursor and an agent filter', async () => {
    const page = runsReply.parse(await get('admin', api(c.brandId, '/runs')))
    expect(page.items.length).toBeGreaterThan(0)
    runsReply.parse(await get('admin', api(c.brandId, '/runs?agent=summary')))
  })
  it('run detail', async () => {
    const detail = runDetailReply.parse(await get('admin', api(c.brandId, `/runs/${runId}`)))
    expect(detail.jobs.length).toBe(4)
    expect(detail.modelCalls.length).toBe(2)
    expect(detail.audit.length).toBe(1)
  })
  it('model-call review', async () => {
    const review = modelCallReviewReply.parse(await get('admin', api(c.brandId, '/model-calls/review')))
    expect(review.items.length).toBe(2)
  })
  it('audit search, brand and platform', async () => {
    expect(auditReply.parse(await get('admin', api(c.brandId, '/audit'))).items.length).toBeGreaterThan(0)
    auditReply.parse(await get('owner', '/api/v1/audit/platform'))
  })
  it('audit verify, brand and platform', async () => {
    for (const [who, path] of [
      ['admin', api(c.brandId, '/audit/verify')],
      ['owner', '/api/v1/audit/platform/verify'],
    ] as const) {
      const reply = await c[who].request('POST', path, { body: {} })
      expect(reply.status).toBe(200)
      auditVerifyReply.parse(reply.json)
    }
  })

  it('refuses a reply with an unexpected shape, so the schemas are not vacuous', () => {
    expect(() => statusReply.parse({ killSwitch: { active: 'yes', scopes: [] } })).toThrow()
    expect(() =>
      modelCallReviewReply.parse({ items: [{ id: 'x', cost: { usdMicros: 5, inrMicros: 6 } }] }),
    ).toThrow()
  })
})
