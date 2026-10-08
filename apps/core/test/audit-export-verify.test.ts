import { createPool, type Pool } from '@mkt/db'
import { createTestDatabase, seedBrand, type TestDatabase } from '@mkt/db/testing'
import { requireDatabase } from '@mkt/test-support'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { exportAudit } from '../src/audit/export.ts'
import { MemoryExportStore } from '../src/audit/store.ts'
import { verifyAudit, type Finding } from '../src/audit/verify.ts'
import { DbAudit } from '../src/audit/db-audit.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

describe('exporting and verifying the audit log', () => {
  let db: TestDatabase
  let reader: Pool
  let writer: Pool
  let audit: DbAudit
  let store: MemoryExportStore

  async function tamper(sql: string, params: unknown[] = []) {
    const client = await db.admin.connect()
    try {
      await client.query('set session_replication_role = replica')
      await client.query(sql, params)
    } finally {
      await client.query('reset session_replication_role')
      client.release()
    }
  }

  async function fill(brand: string | null, count: number) {
    for (let i = 0; i < count; i += 1) {
      await audit.record({
        action: 'test.entry',
        actor: null,
        brandId: brand,
        outcome: 'success',
        detail: { i },
      })
    }
  }

  beforeAll(async () => {
    await requireDatabase()
  })
  // A fresh database for each test, so one test's tampering cannot leak into the next.
  beforeEach(async () => {
    db = await createTestDatabase()
    await seedBrand(db, A, 'brand-a')
    await seedBrand(db, B, 'brand-b')
    reader = createPool(db.urlFor('owner_view'))
    writer = createPool(db.urlFor('audit_writer'))
    audit = new DbAudit(writer)
    store = new MemoryExportStore()
    await fill(A, 5)
    await fill(B, 3)
    await fill(null, 2)
  })
  afterEach(async () => {
    await reader.end()
    await writer.end()
    await db.drop()
  })

  it('exports each chain once, in batches, and exports only what is new the next time', async () => {
    const first = await exportAudit({ reader, writer, store, batchSize: 3 })
    expect(first).toEqual({ chains: 3, batches: 4, entries: 10 })
    const marks = await store.marks(A)
    expect(marks.map((m) => m.throughSeq)).toEqual([3, 5])
    expect(await exportAudit({ reader, writer, store })).toEqual({ chains: 3, batches: 0, entries: 0 })
    await fill(A, 2)
    expect(await exportAudit({ reader, writer, store })).toEqual({ chains: 3, batches: 1, entries: 2 })
    const recorded = await db.admin.query(
      'select through_seq from audit.export where chain_key = $1 order by through_seq',
      [A],
    )
    expect(recorded.rows.map((r) => Number(r.through_seq))).toEqual([3, 5, 7])
  })

  it('carries on after a crash between storing a batch and recording it', async () => {
    await exportAudit({ reader, writer, store })
    await db.admin.query('alter table audit.export disable trigger all')
    await db.admin.query('delete from audit.export')
    await db.admin.query('alter table audit.export enable trigger all')
    // The store already holds the batches; running again records them without error.
    await expect(exportAudit({ reader, writer, store })).resolves.toBeDefined()
    const recorded = await db.admin.query('select count(*)::int as n from audit.export')
    expect(recorded.rows[0].n).toBe(3)
  })

  it('reports nothing wrong for an intact log that has been exported', async () => {
    await exportAudit({ reader, writer, store })
    const calls: Finding[][] = []
    const report = await verifyAudit({ reader, store, onMismatch: (f) => void calls.push(f) })
    expect(report).toEqual({ ok: true, chains: 3, findings: [] })
    expect(calls).toHaveLength(0)
  })

  it('finds an altered entry (test 35)', async () => {
    await exportAudit({ reader, writer, store })
    await tamper("update audit.log set action = 'test.altered' where chain_key = $1 and seq = 2", [A])
    const calls: Finding[][] = []
    const report = await verifyAudit({ reader, store, onMismatch: (f) => void calls.push(f) })
    expect(report.ok).toBe(false)
    expect(report.findings).toContainEqual(
      expect.objectContaining({ chainKey: A, kind: 'broken_chain', seq: 2 }),
    )
    expect(calls).toHaveLength(1)
  })

  it('finds an entry altered together with its hash, which the chain alone cannot see (Review Focus 6)', async () => {
    await exportAudit({ reader, writer, store })
    await tamper(
      `update audit.log set subject = 'rewritten',
         hash = audit.entry_hash(chain_key, seq, at, actor_kind, actor_id, action, outcome, 'rewritten', detail, prev_hash)
       where chain_key = $1 and seq = 5`,
      [A],
    )
    const report = await verifyAudit({ reader, store })
    expect(report.findings).toEqual([
      expect.objectContaining({ chainKey: A, kind: 'export_mismatch', seq: 5 }),
    ])
  })

  it('finds entries cut off the end of a chain', async () => {
    await exportAudit({ reader, writer, store })
    await tamper('delete from audit.log where chain_key = $1 and seq in (4, 5)', [A])
    const report = await verifyAudit({ reader, store })
    expect(report.findings).toContainEqual(
      expect.objectContaining({ chainKey: A, kind: 'log_shorter_than_export' }),
    )
  })

  it('finds a chain that was removed altogether', async () => {
    await exportAudit({ reader, writer, store })
    await tamper('delete from audit.log where chain_key = $1', [B])
    const report = await verifyAudit({ reader, store })
    expect(report.findings).toContainEqual(expect.objectContaining({ chainKey: B, kind: 'chain_missing' }))
  })

  it('refuses to overwrite what the store already holds', async () => {
    await exportAudit({ reader, writer, store })
    await expect(
      store.put({
        chainKey: A,
        fromSeq: 1,
        throughSeq: 5,
        headHash: 'sha256:' + '0'.repeat(64),
        entries: [],
      }),
    ).rejects.toThrow()
  })

  it('refuses to export when the database claims an export the store does not hold (forged record)', async () => {
    await exportAudit({ reader, writer, store })
    const before = JSON.stringify([await store.marks(A), await store.marks(B), await store.chainKeys()])
    await db.admin.query(
      "insert into audit.export (chain_key, through_seq, chain_hash, location) values ($1, 1000000, $2, 'forged')",
      [A, 'sha256:' + '1'.repeat(64)],
    )
    await fill(A, 2)
    await expect(exportAudit({ reader, writer, store })).rejects.toThrow(/exceeds/)
    expect(JSON.stringify([await store.marks(A), await store.marks(B), await store.chainKeys()])).toBe(before)
  })

  it('refuses to export when the recorded point is ahead of the store but not past the head', async () => {
    await exportAudit({ reader, writer, store })
    const fresh = new MemoryExportStore()
    await expect(exportAudit({ reader, writer, store: fresh })).rejects.toThrow(/exceeds/)
    expect(await fresh.chainKeys()).toEqual([])
  })

  it('finds a middle entry rewritten with the whole tail re-hashed consistently', async () => {
    await exportAudit({ reader, writer, store, batchSize: 3 })
    await tamper(`do $$
      declare r audit.log%rowtype; v_prev text;
      begin
        select hash into v_prev from audit.log where chain_key = '${A}' and seq = 1;
        for r in select * from audit.log where chain_key = '${A}' and seq >= 2 order by seq loop
          update audit.log set prev_hash = v_prev,
            subject = case when seq = 2 then 'rewritten' else subject end,
            hash = audit.entry_hash(chain_key, seq, at, actor_kind, actor_id, action, outcome,
                     case when seq = 2 then 'rewritten' else subject end, detail, v_prev)
          where chain_key = '${A}' and seq = r.seq returning hash into v_prev;
        end loop;
      end $$`)
    const report = await verifyAudit({ reader, store })
    expect(report.findings.some((f) => f.kind === 'broken_chain')).toBe(false)
    expect(report.findings).toContainEqual(
      expect.objectContaining({ chainKey: A, kind: 'export_mismatch', seq: 3 }),
    )
  })

  it('the store hands back the same location for the same batch and refuses a different one', async () => {
    const batch = {
      chainKey: A,
      fromSeq: 1,
      throughSeq: 2,
      headHash: 'sha256:' + 'a'.repeat(64),
      entries: [],
    }
    const first = await store.put(batch)
    expect(await store.put(batch)).toBe(first)
    await expect(store.put({ ...batch, headHash: 'sha256:' + 'b'.repeat(64) })).rejects.toThrow()
  })
})
