import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportAudit } from '../src/audit/export.ts'
import { TamperedStore, api, cast, readsStack, statuses, type Cast } from './reads-support.ts'
import type { Stack } from './support.ts'

let stack: Stack
let store: TamperedStore
let c: Cast
let other: Cast

async function append(
  chain: string | null,
  action: string,
  actor: string | null = null,
  detail: unknown = null,
) {
  await stack.auditPool!.query(
    `select audit.append($1::uuid, $2::app.actor_kind, $3::uuid, $4, 'success', null, $5::jsonb)`,
    [chain, actor ? 'user' : 'system', actor, action, detail === null ? null : JSON.stringify(detail)],
  )
}

async function readsOf(chain: string) {
  const { rows } = await stack.db.admin.query(
    `select seq, actor_id, subject, detail from audit.log where chain_key = $1 and action = 'audit.read' order by seq`,
    [chain],
  )
  return rows as {
    seq: string
    actor_id: string | null
    subject: string | null
    detail: Record<string, unknown>
  }[]
}

async function verifiedOf(chain: string) {
  const { rows } = await stack.db.admin.query(
    `select detail from audit.log where chain_key = $1 and action = 'audit.verified' order by seq`,
    [chain],
  )
  return rows as { detail: Record<string, unknown> }[]
}

beforeAll(async () => {
  store = new TamperedStore()
  stack = await readsStack(store)
  c = await cast(stack)
  other = await cast(stack)
  for (let i = 0; i < 7; i += 1)
    await append(c.brandId, i % 2 === 0 ? 'test.even' : 'test.odd', c.adminId, { i })
  await append(other.brandId, 'test.secret', null, { secret: 'brand-b-only' })
  await append(null, 'test.platform')
})
afterAll(async () => stack?.close())

describe('GET /brands/:brandId/audit', () => {
  it('is for the owner and the brand admin', async () => {
    expect(await statuses(c, 'GET', api(c.brandId, '/audit'))).toEqual([200, 200, 403, 403, 404])
  })

  it('returns the brand chain newest first and never another brand’s or the platform’s entries', async () => {
    const reply = await c.admin.request('GET', api(c.brandId, '/audit'))
    expect(reply.status).toBe(200)
    const seqs = reply.json.items.map((e: { seq: number }) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a))
    expect(reply.json.items.map((e: { action: string }) => e.action)).toContain('test.even')
    expect(reply.text).not.toContain('brand-b-only')
    expect(reply.text).not.toContain('test.platform')
    expect(reply.json.items[0]).toEqual(
      expect.objectContaining({
        seq: expect.any(Number),
        at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
        actorKind: expect.any(String),
        action: expect.any(String),
        outcome: 'success',
      }),
    )
  })

  it('filters by actor, action and time, and refuses a malformed filter', async () => {
    const byAction = await c.admin.request('GET', api(c.brandId, '/audit?action=test.odd'))
    expect(byAction.json.items).toHaveLength(3)
    expect(byAction.json.items.every((e: { action: string }) => e.action === 'test.odd')).toBe(true)
    const byActor = await c.admin.request('GET', api(c.brandId, `/audit?actor=${c.adminId}&action=test.even`))
    expect(byActor.json.items).toHaveLength(4)
    const nobody = await c.admin.request(
      'GET',
      api(c.brandId, '/audit?actor=3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b'),
    )
    expect(nobody.json.items).toEqual([])
    const future = await c.admin.request('GET', api(c.brandId, '/audit?from=2999-01-01T00:00:00Z'))
    expect(future.json.items).toEqual([])
    const past = await c.admin.request('GET', api(c.brandId, '/audit?to=2000-01-01T00:00:00Z'))
    expect(past.json.items).toEqual([])
    const window = await c.admin.request(
      'GET',
      api(c.brandId, '/audit?from=2000-01-01T00:00:00Z&to=2999-01-01T00:00:00Z&action=test.even'),
    )
    expect(window.json.items).toHaveLength(4)
    expect((await c.admin.request('GET', api(c.brandId, '/audit?actor=nope'))).status).toBe(400)
    expect((await c.admin.request('GET', api(c.brandId, '/audit?before=abc'))).status).toBe(400)
    expect((await c.admin.request('GET', api(c.brandId, '/audit?surprise=1'))).status).toBe(400)
  })

  it('pages with before, 50 at a time', async () => {
    const mine = await cast(stack)
    for (let i = 0; i < 55; i += 1) await append(mine.brandId, 'test.bulk')
    const first = await mine.admin.request('GET', api(mine.brandId, '/audit?action=test.bulk'))
    expect(first.json.items).toHaveLength(50)
    expect(first.json.nextBefore).toBe(first.json.items[49].seq)
    const second = await mine.admin.request(
      'GET',
      api(mine.brandId, `/audit?action=test.bulk&before=${first.json.nextBefore}`),
    )
    expect(second.json.items).toHaveLength(5)
    expect(second.json.nextBefore).toBeNull()
  })

  it('writes exactly one audit.read per read, naming the filters and none of the rows', async () => {
    const mine = await cast(stack)
    await append(mine.brandId, 'test.visible', null, { marker: 'row-content-xyz' })
    expect(await readsOf(mine.brandId)).toHaveLength(0)
    await mine.admin.request('GET', api(mine.brandId, '/audit?action=test.visible'))
    let reads = await readsOf(mine.brandId)
    expect(reads).toHaveLength(1)
    expect(reads[0]!.actor_id).toBe(mine.adminId)
    expect(reads[0]!.detail).toEqual({ action: 'test.visible' })
    expect(JSON.stringify(reads[0])).not.toContain('row-content-xyz')
    // A refused read writes nothing.
    await mine.viewer.request('GET', api(mine.brandId, '/audit'))
    await mine.stranger.request('GET', api(mine.brandId, '/audit'))
    expect(await readsOf(mine.brandId)).toHaveLength(1)
    // The owner's read goes to the same brand chain.
    await mine.owner.request('GET', api(mine.brandId, '/audit'))
    reads = await readsOf(mine.brandId)
    expect(reads).toHaveLength(2)
    expect(reads[1]!.detail).toEqual({})
    // Nothing leaks onto the platform chain.
    expect((await readsOf('platform')).every((r) => r.subject !== mine.brandId)).toBe(true)
  })
})

describe('POST /brands/:brandId/audit/verify', () => {
  it('is for the owner and the brand admin', async () => {
    expect(await statuses(c, 'POST', api(c.brandId, '/audit/verify'), {})).toEqual([200, 200, 403, 403, 404])
  })

  it('reports ok with no finding and the last export, and audits audit.verified once', async () => {
    const mine = await cast(stack)
    await append(mine.brandId, 'test.a')
    await append(mine.brandId, 'test.b')
    await exportAudit({ reader: stack.ownerViewPool!, writer: stack.auditPool!, store })
    const before = (await verifiedOf(mine.brandId)).length
    const reply = await mine.admin.request('POST', api(mine.brandId, '/audit/verify'), { body: {} })
    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ ok: true, findings: [] })
    expect(reply.json.checkedAt).toMatch(/^2026-10-20T12:00:00/)
    expect(reply.json.lastExport.throughSeq).toBeGreaterThanOrEqual(2)
    expect(typeof reply.json.lastExport.exportedAt).toBe('string')
    const after = await verifiedOf(mine.brandId)
    expect(after.length - before).toBe(1)
    expect(after[after.length - 1]!.detail).toMatchObject({ ok: true })
  })

  it('has no last export for a chain that was never exported', async () => {
    const mine = await cast(stack)
    await append(mine.brandId, 'test.a')
    const reply = await mine.admin.request('POST', api(mine.brandId, '/audit/verify'), { body: {} })
    expect(reply.json).toMatchObject({ ok: true, findings: [], lastExport: null })
  })

  it('reports a mismatch after an export mark is altered, in the store or in the database', async () => {
    const mine = await cast(stack)
    await append(mine.brandId, 'test.a')
    await append(mine.brandId, 'test.b')
    await exportAudit({ reader: stack.ownerViewPool!, writer: stack.auditPool!, store })
    store.tamper = true
    try {
      const reply = await mine.admin.request('POST', api(mine.brandId, '/audit/verify'), { body: {} })
      expect(reply.json.ok).toBe(false)
      expect(reply.json.findings).toEqual([{ kind: 'export_mismatch', seq: expect.any(Number) }])
    } finally {
      store.tamper = false
    }
    const clean = await mine.admin.request('POST', api(mine.brandId, '/audit/verify'), { body: {} })
    expect(clean.json.ok).toBe(true)

    // The database's own record of the export altered (the audit tables refuse changes except to a superuser
    // who switches the triggers off, which is what tampering is).
    const client = await stack.db.admin.connect()
    try {
      await client.query('set session_replication_role = replica')
      await client.query(`update audit.export set chain_hash = $2 where chain_key = $1`, [
        mine.brandId,
        'sha256:' + '0'.repeat(64),
      ])
    } finally {
      await client.query('reset session_replication_role')
      client.release()
    }
    const altered = await mine.admin.request('POST', api(mine.brandId, '/audit/verify'), { body: {} })
    expect(altered.json.ok).toBe(false)
    expect(altered.json.findings[0]).toMatchObject({ kind: 'export_mismatch' })
    const recorded = await verifiedOf(mine.brandId)
    expect(recorded[recorded.length - 1]!.detail).toMatchObject({ ok: false })
  })

  it('reports a broken chain', async () => {
    const mine = await cast(stack)
    await append(mine.brandId, 'test.a')
    await append(mine.brandId, 'test.b')
    const client = await stack.db.admin.connect()
    try {
      await client.query('set session_replication_role = replica')
      await client.query(`update audit.log set action = 'test.changed' where chain_key = $1 and seq = 1`, [
        mine.brandId,
      ])
    } finally {
      await client.query('reset session_replication_role')
      client.release()
    }
    const reply = await mine.admin.request('POST', api(mine.brandId, '/audit/verify'), { body: {} })
    expect(reply.json.ok).toBe(false)
    expect(reply.json.findings).toEqual([{ kind: 'broken_chain', seq: 1 }])
  })
})

describe('the platform chain', () => {
  it('is the platform owner’s alone', async () => {
    expect(await statuses(c, 'GET', '/api/v1/audit/platform')).toEqual([200, 403, 403, 403, 403])
    expect(await statuses(c, 'POST', '/api/v1/audit/platform/verify', {})).toEqual([200, 403, 403, 403, 403])
  })

  it('returns platform entries only, and audits audit.read and audit.verified on the platform chain', async () => {
    const before = (await readsOf('platform')).length
    const reply = await c.owner.request('GET', '/api/v1/audit/platform?action=test.platform')
    expect(reply.json.items.map((e: { action: string }) => e.action)).toEqual(['test.platform'])
    expect(reply.text).not.toContain('brand-b-only')
    const reads = await readsOf('platform')
    expect(reads.length - before).toBe(1)
    expect(reads[reads.length - 1]!.detail).toEqual({ action: 'test.platform' })
    const verified = await verifiedOf('platform')
    const verify = await c.owner.request('POST', '/api/v1/audit/platform/verify', { body: {} })
    expect(verify.json).toMatchObject({ ok: true, findings: [] })
    expect((await verifiedOf('platform')).length - verified.length).toBe(1)
  })
})

describe('when no export store is configured', () => {
  it('still verifies the chain itself', async () => {
    const bare = await readsStack(null)
    try {
      const mine = await cast(bare)
      const reply = await mine.admin.request('POST', api(mine.brandId, '/audit/verify'), { body: {} })
      expect(reply.json).toMatchObject({ ok: true, findings: [], lastExport: null })
    } finally {
      await bare.close()
    }
  })
})
