import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '../src/with-brand.ts'
import { createTestDatabase, seedBrand, type TestDatabase } from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

describe('withBrand', () => {
  let db: TestDatabase
  let pool: pg.Pool
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    await seedBrand(db, A, 'brand-a')
    await seedBrand(db, B, 'brand-b')
    // One connection only, so a leaked setting would be seen by the next call.
    pool = new pg.Pool({ connectionString: db.urlFor('app'), max: 1 })
  })
  afterAll(async () => {
    await pool?.end()
    await db?.drop()
  })

  it('shows the work only the brand it was given', async () => {
    const rows = await withBrand(pool, A, (c) => c.query('select distinct brand_id from app.content_item'))
    expect(rows.rows.map((r) => r.brand_id)).toEqual([A])
  })

  it('does not leave the brand set for the next user of the same connection', async () => {
    await withBrand(pool, A, (c) => c.query('select 1'))
    const after = await pool.query("select current_setting('app.brand_id', true) as brand")
    expect(after.rows[0].brand === null || after.rows[0].brand === '').toBe(true)
    const none = await pool.query('select count(*)::int as n from app.content_item')
    expect(none.rows[0].n).toBe(0)
  })

  it('rolls back everything when the work throws, and still releases the connection', async () => {
    await expect(
      withBrand(pool, A, async (c) => {
        await c.query("insert into app.content_item (brand_id, kind) values ($1, 'summary')", [A])
        throw new Error('stop')
      }),
    ).rejects.toThrow('stop')
    const count = await withBrand(pool, A, (c) => c.query('select count(*)::int as n from app.content_item'))
    expect(count.rows[0].n).toBe(1)
  })

  it('rejects a brand ID that is not a UUID before any query is sent', async () => {
    await expect(withBrand(pool, "x'; drop table app.brand; --", async () => 1)).rejects.toThrow(
      'not a valid brand ID',
    )
  })
})
