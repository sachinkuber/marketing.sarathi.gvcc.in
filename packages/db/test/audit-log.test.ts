import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, seedBrand, type RoleName, type TestDatabase } from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const NOBODY = '00000000-0000-4000-8000-0000000000ff'

const APPEND = 'select audit.append($1::uuid, $2::app.actor_kind, $3::uuid, $4, $5, $6, $7::jsonb) as seq'

async function run(db: TestDatabase, role: RoleName, sql: string, params: unknown[] = [], brand?: string) {
  const client = new pg.Client({ connectionString: db.urlFor(role) })
  await client.connect()
  try {
    await client.query('begin')
    if (brand) await client.query("select set_config('app.brand_id', $1, true)", [brand])
    const result = await client.query(sql, params)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

// How many entries of a chain are out of place: a sequence number that is not 1, 2, 3 ... or a previous hash
// that is not the hash of the entry before.
async function brokenCount(db: TestDatabase, chain: string): Promise<number> {
  const result = await db.admin.query(
    `select count(*)::int as bad from (
       select seq, prev_hash, lag(hash) over (order by seq) as expected, row_number() over (order by seq) as rn
         from audit.log where chain_key = $1) t
      where seq <> rn or prev_hash is distinct from expected`,
    [chain],
  )
  return result.rows[0].bad as number
}

describe('the audit log', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    await seedBrand(db, A, 'brand-a')
    await seedBrand(db, B, 'brand-b')
  })
  afterAll(async () => db?.drop())

  it('gives no run-time role any right on an audit table, and no role any way to change one (test 35)', async () => {
    for (const role of ['app', 'queue', 'audit_writer', 'owner_view', 'readonly'] as const) {
      await expect(run(db, role, 'select * from audit.log'), role).rejects.toMatchObject({ code: '42501' })
      await expect(
        run(db, role, "insert into audit.log (chain_key) values ('x')"),
        role,
      ).rejects.toMatchObject({ code: '42501' })
    }
    await run(db, 'audit_writer', APPEND, [A, 'user', null, 'test.one', 'success', null, null])
    // The owner of the table and the superuser are stopped by the triggers.
    for (const sql of [
      "update audit.log set action = 'x.y'",
      'delete from audit.log',
      'truncate audit.log',
    ]) {
      await expect(db.admin.query(sql), sql).rejects.toMatchObject({ code: '42501' })
      const owner = new pg.Client({ connectionString: db.urlFor('migration') })
      await owner.connect()
      try {
        await expect(owner.query(sql), sql).rejects.toMatchObject({ code: '42501' })
      } finally {
        await owner.end()
      }
    }
  })

  it('numbers a chain from 1 and links each entry to the one before', async () => {
    const first = await run(db, 'audit_writer', APPEND, [
      B,
      'user',
      null,
      'test.first',
      'success',
      'subject-1',
      '{"k":1}',
    ])
    const second = await run(db, 'audit_writer', APPEND, [
      B,
      'system',
      null,
      'test.second',
      'failure',
      null,
      null,
    ])
    expect(Number(first.rows[0].seq)).toBe(1)
    expect(Number(second.rows[0].seq)).toBe(2)
    const rows = await db.admin.query(
      'select seq, prev_hash, hash, chain_key, brand_id from audit.log where chain_key = $1 order by seq',
      [B],
    )
    expect(rows.rows[0].prev_hash).toBeNull()
    expect(rows.rows[1].prev_hash).toBe(rows.rows[0].hash)
    expect(rows.rows[0].hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(rows.rows[0].brand_id).toBe(B)
  })

  it('keeps entries with no brand on the platform chain', async () => {
    const result = await run(db, 'audit_writer', APPEND, [
      null,
      'system',
      null,
      'auth.sign_in',
      'failure',
      null,
      null,
    ])
    expect(Number(result.rows[0].seq)).toBe(1)
    const rows = await db.admin.query(
      "select chain_key, brand_id from audit.log where action = 'auth.sign_in'",
    )
    expect(rows.rows).toEqual([{ chain_key: 'platform', brand_id: null }])
  })

  it('refuses an entry for a brand that does not exist, and a malformed action or outcome', async () => {
    await expect(
      run(db, 'audit_writer', APPEND, [NOBODY, 'user', null, 'test.x', 'success', null, null]),
    ).rejects.toMatchObject({ code: '23503' })
    await expect(
      run(db, 'audit_writer', APPEND, [A, 'user', null, 'Not An Action', 'success', null, null]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      run(db, 'audit_writer', APPEND, [A, 'user', null, 'test.x', 'maybe', null, null]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses a session working in brand A that appends to brand B or to a brand that does not exist (Review Focus 5)', async () => {
    await expect(
      run(db, 'app', APPEND, [B, 'user', null, 'test.forged', 'success', null, null], A),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      run(db, 'app', APPEND, [NOBODY, 'user', null, 'test.forged', 'success', null, null], A),
    ).rejects.toMatchObject({ code: '42501' })
    const own = await run(db, 'app', APPEND, [A, 'user', null, 'test.own', 'success', null, null], A)
    expect(Number(own.rows[0].seq)).toBeGreaterThanOrEqual(1)
  })

  it('leaves no gap when a transaction that appended is rolled back (Review Focus 4)', async () => {
    const before = await db.admin.query(
      'select coalesce(max(seq), 0)::int as n from audit.log where chain_key = $1',
      [A],
    )
    const client = new pg.Client({ connectionString: db.urlFor('audit_writer') })
    await client.connect()
    try {
      await client.query('begin')
      await client.query(APPEND, [A, 'user', null, 'test.rolled_back', 'success', null, null])
      await client.query('rollback')
    } finally {
      await client.end()
    }
    const next = await run(db, 'audit_writer', APPEND, [A, 'user', null, 'test.after', 'success', null, null])
    expect(Number(next.rows[0].seq)).toBe((before.rows[0].n as number) + 1)
    expect(await brokenCount(db, A)).toBe(0)
  })

  it('keeps every chain unbroken under fifty concurrent writers on several chains (test 36)', async () => {
    const pool = new pg.Pool({ connectionString: db.urlFor('audit_writer'), max: 12 })
    try {
      const targets = [
        ...Array.from({ length: 30 }, () => A),
        ...Array.from({ length: 12 }, () => B),
        ...Array.from({ length: 8 }, () => null),
      ]
      const before = await db.admin.query('select chain_key, count(*)::int as n from audit.log group by 1')
      const had = new Map(before.rows.map((r) => [r.chain_key as string, r.n as number]))
      const results = await Promise.all(
        targets.map((brand, i) =>
          pool.query(APPEND, [brand, 'system', null, 'test.concurrent', 'success', `n${i}`, null]),
        ),
      )
      expect(results).toHaveLength(50)
      for (const [chain, added] of [
        [A, 30],
        [B, 12],
        ['platform', 8],
      ] as const) {
        const now = await db.admin.query(
          'select count(*)::int as n, count(distinct seq)::int as d, max(seq)::int as top from audit.log where chain_key = $1',
          [chain],
        )
        expect(now.rows[0].n).toBe((had.get(chain) ?? 0) + added)
        expect(now.rows[0].d).toBe(now.rows[0].n)
        expect(now.rows[0].top).toBe(now.rows[0].n)
        expect(await brokenCount(db, chain)).toBe(0)
      }
    } finally {
      await pool.end()
    }
  })
})
