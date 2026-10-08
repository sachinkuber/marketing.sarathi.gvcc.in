import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, seedBrand, type RoleName, type TestDatabase } from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const APPEND = 'select audit.append($1::uuid, $2::app.actor_kind, $3::uuid, $4, $5, $6, $7::jsonb) as seq'

async function run(db: TestDatabase, role: RoleName, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: db.urlFor(role) })
  await client.connect()
  try {
    return await client.query(sql, params)
  } finally {
    await client.end()
  }
}

// Runs SQL as the superuser with the audit triggers switched off for the session: the position of someone
// with write access to the database who wants to alter the log.
async function tamper(db: TestDatabase, sql: string, params: unknown[] = []): Promise<void> {
  const client = await db.admin.connect()
  try {
    await client.query('set session_replication_role = replica')
    await client.query(sql, params)
  } finally {
    await client.query('reset session_replication_role')
    client.release()
  }
}

async function seedChain(db: TestDatabase, length: number): Promise<void> {
  for (let i = 1; i <= length; i += 1) {
    await run(db, 'audit_writer', APPEND, [
      A,
      'system',
      null,
      'test.entry',
      'success',
      `s${i}`,
      JSON.stringify({ i }),
    ])
  }
}

describe('reading and verifying the audit log (test 35, verification half)', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    await seedBrand(db, A, 'brand-a')
    await seedChain(db, 5)
  })
  afterAll(async () => db?.drop())

  it('gives the readers to the owner-view role and the export recorder to the audit-writer role, and no one else', async () => {
    const reads = [
      'select * from audit.chain_heads()',
      "select * from audit.entries_after('x', 0, 10)",
      "select audit.hash_at('x', 1)",
      "select * from audit.verify_chain('x')",
      "select * from audit.exports_for('x')",
    ]
    for (const sql of reads) {
      await run(db, 'owner_view', sql)
      for (const role of ['app', 'queue', 'audit_writer', 'readonly'] as const) {
        await expect(run(db, role, sql), `${role}: ${sql}`).rejects.toMatchObject({ code: '42501' })
      }
    }
    const record = "select audit.record_export('x', 1, 'sha256:' || repeat('0', 64), 'somewhere')"
    for (const role of ['app', 'queue', 'owner_view', 'readonly'] as const) {
      await expect(run(db, role, record), role).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('lists chain heads and pages through entries in order', async () => {
    const heads = await run(db, 'owner_view', 'select * from audit.chain_heads()')
    expect(heads.rows).toHaveLength(1)
    expect(heads.rows[0].chain_key).toBe(A)
    expect(Number(heads.rows[0].head_seq)).toBe(5)
    const page = await run(db, 'owner_view', 'select seq from audit.entries_after($1, 2, 2)', [A])
    expect(page.rows.map((r) => Number(r.seq))).toEqual([3, 4])
  })

  it('verifies an intact chain', async () => {
    const result = await run(db, 'owner_view', 'select * from audit.verify_chain($1)', [A])
    expect(result.rows[0]).toMatchObject({ ok: true, broken_at: null })
    expect(Number(result.rows[0].checked)).toBe(5)
  })

  it('records an export only when it matches the log', async () => {
    const hash = (await run(db, 'owner_view', 'select audit.hash_at($1, 3) as h', [A])).rows[0].h as string
    await run(db, 'audit_writer', 'select audit.record_export($1, 3, $2, $3)', [A, hash, 'store://a/3'])
    await expect(
      run(db, 'audit_writer', 'select audit.record_export($1, 4, $2, $3)', [A, hash, 'store://a/4']),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      run(db, 'audit_writer', 'select audit.record_export($1, 99, $2, $3)', [A, hash, 'store://a/99']),
    ).rejects.toMatchObject({ code: '23514' })
    const exports = await run(db, 'owner_view', 'select through_seq from audit.exports_for($1)', [A])
    expect(exports.rows.map((r) => Number(r.through_seq))).toEqual([3])
  })

  it('finds an entry that was altered, at that entry', async () => {
    await tamper(db, "update audit.log set action = 'test.altered' where chain_key = $1 and seq = 2", [A])
    const result = await run(db, 'owner_view', 'select * from audit.verify_chain($1)', [A])
    expect(result.rows[0].ok).toBe(false)
    expect(Number(result.rows[0].broken_at)).toBe(2)
    await tamper(db, "update audit.log set action = 'test.entry' where chain_key = $1 and seq = 2", [A])
    expect((await run(db, 'owner_view', 'select ok from audit.verify_chain($1)', [A])).rows[0].ok).toBe(true)
  })

  it('finds an entry that was removed from the middle, at the gap', async () => {
    const saved = (
      await db.admin.query('select *, at::text as at_text from audit.log where chain_key = $1 and seq = 3', [
        A,
      ])
    ).rows[0]
    await tamper(db, 'delete from audit.log where chain_key = $1 and seq = 3', [A])
    const result = await run(db, 'owner_view', 'select * from audit.verify_chain($1)', [A])
    expect(result.rows[0].ok).toBe(false)
    expect(Number(result.rows[0].broken_at)).toBe(4)
    await tamper(
      db,
      `insert into audit.log (id, chain_key, brand_id, seq, at, actor_kind, actor_id, action, outcome, subject, detail, prev_hash, hash)
       values ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        saved.id,
        saved.chain_key,
        saved.brand_id,
        saved.seq,
        saved.at_text,
        saved.actor_kind,
        saved.actor_id,
        saved.action,
        saved.outcome,
        saved.subject,
        saved.detail,
        saved.prev_hash,
        saved.hash,
      ],
    )
    expect((await run(db, 'owner_view', 'select ok from audit.verify_chain($1)', [A])).rows[0].ok).toBe(true)
  })

  it('does not see, in the chain alone, an entry that was altered together with its hash or a chain cut short (Review Focus 6)', async () => {
    // Rewrites the last entry and recomputes its hash: the chain still checks out, which is why the export
    // exists. Task 8 shows the comparison against the export catching it.
    await tamper(
      db,
      `update audit.log set subject = 'rewritten',
         hash = audit.entry_hash(chain_key, seq, at, actor_kind, actor_id, action, outcome, 'rewritten', detail, prev_hash)
       where chain_key = $1 and seq = 5`,
      [A],
    )
    expect((await run(db, 'owner_view', 'select ok from audit.verify_chain($1)', [A])).rows[0].ok).toBe(true)
    await tamper(db, 'delete from audit.log where chain_key = $1 and seq = 5', [A])
    const cut = await run(db, 'owner_view', 'select * from audit.verify_chain($1)', [A])
    expect(cut.rows[0].ok).toBe(true)
    expect(Number(cut.rows[0].checked)).toBe(4)
    expect((await run(db, 'owner_view', 'select audit.hash_at($1, 5) as h', [A])).rows[0].h).toBeNull()
  })
})
