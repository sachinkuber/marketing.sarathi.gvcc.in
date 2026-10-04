import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createTestDatabase,
  RUNTIME_ROLES,
  seedBrand,
  type RoleName,
  type TestDatabase,
} from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
// Tables seeded by seedBrand. The catalog test proves the same policy exists on all the others.
const SEEDED = ['membership', 'invite', 'content_item', 'content_version', 'kill_switch']

async function as<T>(
  db: TestDatabase,
  role: RoleName,
  brand: string | null,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: db.urlFor(role) })
  await client.connect()
  try {
    await client.query('begin')
    if (brand) await client.query("select set_config('app.brand_id', $1, true)", [brand])
    return await fn(client)
  } finally {
    await client.query('rollback').catch(() => undefined)
    await client.end()
  }
}

describe('tenant isolation in the database (acceptance tests 2, 3 and 5)', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    await seedBrand(db, A, 'brand-a')
    await seedBrand(db, B, 'brand-b')
  })
  afterAll(async () => db.drop())

  for (const table of SEEDED) {
    it(`the application role sees only its own brand's rows in ${table}`, async () => {
      const own = await as(db, 'app', A, (c) => c.query(`select distinct brand_id from app.${table}`))
      expect(own.rows.map((r) => r.brand_id)).toEqual([A])
    })

    it(`the read-only role sees only its own brand's rows in ${table}`, async () => {
      const own = await as(db, 'readonly', B, (c) => c.query(`select distinct brand_id from app.${table}`))
      expect(own.rows.map((r) => r.brand_id)).toEqual([B])
    })

    it(`with no brand set, the application and read-only roles see no rows in ${table}`, async () => {
      for (const role of ['app', 'readonly'] as const) {
        const none = await as(db, role, null, (c) => c.query(`select count(*)::int as n from app.${table}`))
        expect(none.rows[0].n, `${role} ${table}`).toBe(0)
      }
    })
  }

  it('the brand table shows a session only its own brand', async () => {
    const r = await as(db, 'app', A, (c) => c.query('select id from app.brand'))
    expect(r.rows.map((x) => x.id)).toEqual([A])
  })

  it('the queue, audit-writer and owner-view roles cannot read any business table', async () => {
    for (const role of ['queue', 'audit_writer', 'owner_view'] as const) {
      for (const table of [...SEEDED, 'brand', 'approval_setting']) {
        await expect(
          as(db, role, A, (c) => c.query(`select 1 from app.${table} limit 1`)),
          `${role} ${table}`,
        ).rejects.toMatchObject({ code: '42501' })
      }
    }
  })

  it('covers every run-time role', () => {
    expect([...RUNTIME_ROLES].sort()).toEqual(['app', 'audit_writer', 'owner_view', 'queue', 'readonly'])
  })

  it('refuses an insert that carries another brand', async () => {
    await expect(
      as(db, 'app', A, (c) =>
        c.query(
          "insert into app.membership (brand_id, user_id, role) values ($1, gen_random_uuid(), 'viewer')",
          [B],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      as(db, 'app', A, (c) =>
        c.query("insert into app.content_item (brand_id, kind) values ($1, 'summary')", [B]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses an update that moves a row to another brand', async () => {
    await expect(
      as(db, 'app', A, (c) =>
        c.query('update app.content_item set brand_id = $1 where brand_id = $2', [B, A]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses any insert when no brand is set', async () => {
    await expect(
      as(db, 'app', null, (c) =>
        c.query("insert into app.content_item (brand_id, kind) values ($1, 'summary')", [A]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses a row in brand A pointing at a parent row in brand B', async () => {
    const parent = await as(db, 'app', B, (c) => c.query('select id from app.content_item limit 1'))
    await expect(
      as(db, 'app', A, (c) =>
        c.query(
          "insert into app.content_version (brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by_kind) values ($1, $2, 99, '{}', 'sha256:x', 'cv1', 'system')",
          [A, parent.rows[0].id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('cannot be bypassed by the application role altering a table', async () => {
    await expect(
      as(db, 'app', A, (c) => c.query('alter table app.membership disable row level security')),
    ).rejects.toMatchObject({ code: '42501' })
  })
})
