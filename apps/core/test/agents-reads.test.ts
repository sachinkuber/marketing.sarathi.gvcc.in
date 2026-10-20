import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  NOW,
  api,
  cast,
  expectMoneyStrings,
  fxRateId,
  readsStack,
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

beforeAll(async () => {
  stack = await readsStack()
  c = await cast(stack)
  other = await cast(stack)
})
afterAll(async () => stack?.close())

const DAY = 86_400_000

describe('GET /brands/:brandId/agents', () => {
  it('is for the owner and the brand admin', async () => {
    expect(await statuses(c, 'GET', api(c.brandId, '/agents'))).toEqual([200, 200, 403, 403, 404])
  })

  it('shows the live definition, the state and this month’s cost, as strings', async () => {
    await seedRun(stack, c.brandId, { usd: 2_000_000n, inr: 166_000_000n })
    // Last month does not count.
    await seedRun(stack, c.brandId, {
      usd: 9_000_000n,
      startedAt: new Date(NOW.getTime() - 40 * DAY),
    })
    const reply = await c.admin.request('GET', api(c.brandId, '/agents'))
    expect(reply.json.items).toHaveLength(1)
    expect(reply.json.items[0]).toEqual({
      agent: 'summary',
      version: 1,
      model: 'claude-opus-5-5',
      effort: 'low',
      state: 'idle',
      costThisMonth: { usdMicros: '2000000', inrMicros: '166000000' },
    })
    expectMoneyStrings(reply.json)
  })

  it('is running while a run runs, blocked under a covering switch, and idle otherwise', async () => {
    const mine = await cast(stack)
    await seedRun(stack, mine.brandId, { state: 'running' })
    await stack.db.admin.query(
      `insert into app.kill_switch (brand_id, scope, target, active, set_by) values ($1, 'agent', 'summary', true, $2)`,
      [mine.brandId, mine.adminId],
    )
    expect((await mine.admin.request('GET', api(mine.brandId, '/agents'))).json.items[0].state).toBe(
      'running',
    )
    await stack.db.admin.query(`update app.run set state = 'succeeded' where brand_id = $1`, [mine.brandId])
    expect((await mine.admin.request('GET', api(mine.brandId, '/agents'))).json.items[0].state).toBe(
      'blocked',
    )
    await stack.db.admin.query(`update app.kill_switch set active = false where brand_id = $1`, [
      mine.brandId,
    ])
    expect((await mine.admin.request('GET', api(mine.brandId, '/agents'))).json.items[0].state).toBe('idle')
  })

  it('does not show brand A’s cost to brand B', async () => {
    const reply = await other.admin.request('GET', api(other.brandId, '/agents'))
    expect(reply.json.items[0].costThisMonth).toEqual({ usdMicros: '0', inrMicros: '0' })
  })
})

describe('GET /brands/:brandId/runs', () => {
  it('is for the owner and the brand admin', async () => {
    expect(await statuses(c, 'GET', api(c.brandId, '/runs'))).toEqual([200, 200, 403, 403, 404])
  })

  it('pages newest first, 50 at a time, and filters by agent', async () => {
    const mine = await cast(stack)
    const ids: string[] = []
    for (let i = 0; i < 55; i += 1) {
      ids.push(await seedRun(stack, mine.brandId, { startedAt: new Date(NOW.getTime() - i * 60_000) }))
    }
    await seedRun(stack, mine.brandId, { agent: 'writer', startedAt: new Date(NOW.getTime() - 99 * 60_000) })
    const first = await mine.admin.request('GET', api(mine.brandId, '/runs'))
    expect(first.status).toBe(200)
    expect(first.json.items).toHaveLength(50)
    expect(first.json.items.map((r: { id: string }) => r.id)).toEqual(ids.slice(0, 50))
    expect(typeof first.json.nextCursor).toBe('string')
    const second = await mine.admin.request(
      'GET',
      api(mine.brandId, `/runs?cursor=${encodeURIComponent(first.json.nextCursor)}`),
    )
    expect(second.json.items.map((r: { id: string }) => r.id)).toEqual([...ids.slice(50), expect.any(String)])
    expect(second.json.nextCursor).toBeNull()
    const writers = await mine.admin.request('GET', api(mine.brandId, '/runs?agent=writer'))
    expect(writers.json.items).toHaveLength(1)
    expect(writers.json.items[0].agent).toBe('writer')
  })

  it('refuses a malformed cursor', async () => {
    expect((await c.admin.request('GET', api(c.brandId, '/runs?cursor=nonsense'))).status).toBe(400)
  })

  it('never shows another brand’s runs', async () => {
    const mine = await seedRun(stack, c.brandId)
    const theirs = await seedRun(stack, other.brandId)
    const reply = await c.admin.request('GET', api(c.brandId, '/runs'))
    const ids = reply.json.items.map((r: { id: string }) => r.id)
    expect(ids).toContain(mine)
    expect(ids).not.toContain(theirs)
    expectMoneyStrings(reply.json)
  })
})

describe('GET /brands/:brandId/runs/:runId', () => {
  it('is for the owner and the brand admin', async () => {
    const run = await seedRun(stack, c.brandId)
    expect(await statuses(c, 'GET', api(c.brandId, `/runs/${run}`))).toEqual([200, 200, 403, 403, 404])
  })

  it('gives the run, its jobs with attempts, its model calls, the cost total and its audit entries', async () => {
    const mine = await cast(stack)
    const run = await seedRun(stack, mine.brandId, { usd: 3_000_000n, inr: 249_000_000n })
    const job = await seedJob(stack, mine.brandId, run, { attempts: ['failed', 'succeeded'], finished: true })
    const call = await seedCall(stack, mine.brandId, run, { possibleDuplicate: true })
    await stack.auditPool!.query(
      `select audit.append($1::uuid, 'system', null, 'test.run_event', 'success', $2, null)`,
      [mine.brandId, run],
    )
    await stack.auditPool!.query(
      `select audit.append($1::uuid, 'system', null, 'test.other', 'success', 'something-else', null)`,
      [mine.brandId],
    )
    const reply = await mine.admin.request('GET', api(mine.brandId, `/runs/${run}`))
    expect(reply.status).toBe(200)
    expect(reply.json.run).toMatchObject({ id: run, agent: 'summary', state: 'succeeded' })
    expect(reply.json.jobs).toHaveLength(2)
    const mine1 = reply.json.jobs.find((j: { id: string }) => j.id === job)
    expect(mine1).toMatchObject({ state: 'finished' })
    expect(mine1.attempts.map((a: { number: number }) => a.number)).toEqual([1, 2])
    expect(reply.json.modelCalls).toHaveLength(1)
    expect(reply.json.modelCalls[0]).toMatchObject({
      id: call,
      status: 'succeeded',
      possibleDuplicate: true,
      inputTokens: 100,
      outputTokens: 50,
      cost: { usdMicros: '1500000', inrMicros: '124500000' },
    })
    expect(reply.json.cost).toEqual({ usdMicros: '3000000', inrMicros: '249000000' })
    expect(reply.json.audit.map((e: { action: string }) => e.action)).toEqual(['test.run_event'])
    expectMoneyStrings(reply.json)
  })

  it('writes exactly one audit.read on the brand chain, naming the run and no rows', async () => {
    const mine = await cast(stack)
    const run = await seedRun(stack, mine.brandId)
    const before = await auditReads(mine.brandId)
    await mine.admin.request('GET', api(mine.brandId, `/runs/${run}`))
    const after = await auditReads(mine.brandId)
    expect(after.length - before.length).toBe(1)
    expect(after[0]!.detail).toEqual({ runId: run })
    expect(after[0]!.actor_id).not.toBeNull()
  })

  it('is 404 for a run of another brand, and for no run at all', async () => {
    const theirs = await seedRun(stack, other.brandId)
    const across = await c.admin.request('GET', api(c.brandId, `/runs/${theirs}`))
    expect(across.status).toBe(404)
    expect(across.text).not.toContain(theirs)
    const none = await c.admin.request('GET', api(c.brandId, '/runs/3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b'))
    expect(none.status).toBe(404)
  })
})

async function auditReads(brandId: string) {
  const { rows } = await stack.db.admin.query(
    `select seq, actor_id, detail from audit.log where chain_key = $1 and action = 'audit.read' order by seq desc`,
    [brandId],
  )
  return rows as { seq: string; actor_id: string | null; detail: unknown }[]
}

describe('GET /brands/:brandId/model-calls/review', () => {
  it('is for the owner and the brand admin', async () => {
    expect(await statuses(c, 'GET', api(c.brandId, '/model-calls/review'))).toEqual([200, 200, 403, 403, 404])
  })

  it('lists unknown calls, possible duplicates and succeeded calls with no cost row, and no others', async () => {
    const mine = await cast(stack)
    const run = await seedRun(stack, mine.brandId)
    const unknown = await seedCall(stack, mine.brandId, run, { status: 'unknown' })
    const duplicate = await seedCall(stack, mine.brandId, run, { possibleDuplicate: true })
    const noCost = await seedCall(stack, mine.brandId, run)
    const costed = await seedCall(stack, mine.brandId, run)
    const failed = await seedCall(stack, mine.brandId, run, { status: 'failed' })
    await stack.db.admin.query(
      `insert into app.cost_ledger (brand_id, run_id, agent, model_call_id, charged_micros, charged_currency, usd_micros, inr_micros, fx_rate_id)
       values ($1, $2, 'summary', $3, 1, 'USD', 1, 83, $4)`,
      [mine.brandId, run, costed, await fxRateId(stack)],
    )
    const reply = await mine.admin.request('GET', api(mine.brandId, '/model-calls/review'))
    const byId = Object.fromEntries(
      reply.json.items.map((i: { id: string; reason: string }) => [i.id, i.reason]),
    )
    expect(byId).toEqual({ [unknown]: 'unknown', [duplicate]: 'possible_duplicate', [noCost]: 'no_cost' })
    expect(byId[costed]).toBeUndefined()
    expect(byId[failed]).toBeUndefined()
    expectMoneyStrings(reply.json)
  })

  it('does not show another brand’s calls', async () => {
    const theirs = await seedCall(stack, other.brandId, await seedRun(stack, other.brandId), {
      status: 'unknown',
    })
    const reply = await c.admin.request('GET', api(c.brandId, '/model-calls/review'))
    expect(JSON.stringify(reply.json)).not.toContain(theirs)
  })
})
