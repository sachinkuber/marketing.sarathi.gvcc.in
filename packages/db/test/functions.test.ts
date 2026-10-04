import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, seedBrand, type RoleName, type TestDatabase } from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

async function query(db: TestDatabase, role: RoleName, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: db.urlFor(role) })
  await client.connect()
  try {
    return await client.query(sql, params)
  } finally {
    await client.end()
  }
}

describe('named functions for access that crosses brands', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    await seedBrand(db, A, 'brand-a')
    await seedBrand(db, B, 'brand-b')
  })
  afterAll(async () => db?.drop())

  it('lets the owner-view role list every brand, and no other role', async () => {
    const all = await query(db, 'owner_view', 'select slug from app.list_all_brands() order by 1')
    expect(all.rows.map((r) => r.slug)).toEqual(['brand-a', 'brand-b'])
    for (const role of ['app', 'queue', 'readonly', 'audit_writer'] as const) {
      await expect(query(db, role, 'select * from app.list_all_brands()'), role).rejects.toMatchObject({
        code: '42501',
      })
    }
  })

  it("finds a user's memberships across brands with no brand set", async () => {
    // The admin pool is the cluster superuser, used only to read the seeded user's ID.
    const user = await db.admin.query(
      "select user_id from app.membership m join app.brand b on b.id = m.brand_id where b.slug = 'brand-a'",
    )
    const found = await query(db, 'app', 'select brand_id, role from app.memberships_for_user($1)', [
      user.rows[0].user_id,
    ])
    expect(found.rows).toEqual([{ brand_id: A, role: 'approver' }])
  })

  it('answers whether a user is a platform owner, false for an unknown user', async () => {
    const r = await query(db, 'app', 'select app.is_platform_owner(gen_random_uuid()) as owner')
    expect(r.rows[0].owner).toBe(false)
  })

  it('creates a brand with its default approval setting', async () => {
    const created = await query(db, 'app', "select app.create_brand('Test', 'test-brand') as id")
    const id = created.rows[0].id as string
    const client = new pg.Client({ connectionString: db.urlFor('app') })
    await client.connect()
    try {
      await client.query('begin')
      await client.query("select set_config('app.brand_id', $1, true)", [id])
      const setting = await client.query('select reminder_count from app.approval_setting')
      expect(setting.rows).toEqual([{ reminder_count: 3 }])
      await client.query('rollback')
    } finally {
      await client.end()
    }
  })

  it('refuses a bad slug', async () => {
    await expect(query(db, 'app', "select app.create_brand('Bad', 'Bad Slug')")).rejects.toMatchObject({
      code: '23514',
    })
  })

  it('gives an unknown user no memberships', async () => {
    const r = await query(
      db,
      'app',
      'select count(*)::int as n from app.memberships_for_user(gen_random_uuid())',
    )
    expect(r.rows[0].n).toBe(0)
  })
})
