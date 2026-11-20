import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase } from '@mkt/test-support'
import { brandScopedTables } from '../src/isolation-probes.ts'
import { createTestDatabase, seedBrand, type TestDatabase } from '../src/testing.ts'

const A = '11111111-1111-4111-8111-111111111111'
const TABLES = [
  'onboarding',
  'brand_document',
  'brand_document_part',
  'research_source',
  'suggestion',
  'profile_item',
  'questionnaire',
  'question',
  'answer',
  'verified_fact',
  'safety_rule',
  'agent_question',
]
let db: TestDatabase

beforeAll(async () => {
  await requireDatabase()
  db = await createTestDatabase()
  await seedBrand(db, A, 'brand-a')
})
afterAll(async () => {
  await db?.drop()
})

// Runs `fn` as mkt_app with the brand set, in a transaction that is rolled back.
async function asApp<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: db.urlFor('app') })
  await client.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('app.brand_id', $1, true)", [A])
    return await fn(client)
  } finally {
    await client.query('rollback').catch(() => undefined)
    await client.end()
  }
}

async function userId(c: pg.Client): Promise<string> {
  const r = await c.query('select id from auth."user" limit 1')
  return r.rows[0].id as string
}

const code = async (run: () => Promise<unknown>): Promise<string | null> =>
  run().then(
    () => null,
    (e: { code?: string }) => e.code ?? 'no_code',
  )

describe('brand knowledge tables', () => {
  it('creates every knowledge table brand-scoped', async () => {
    const scoped = await brandScopedTables(db.admin)
    for (const t of TABLES) expect(scoped).toContain(t)
  })

  it('refuses an image over 5 MB or a document of another type, and accepts a PDF over 10 MB', async () => {
    const insert = (c: pg.Client, uid: string, size: number, type: string) =>
      c.query(
        `insert into app.brand_document (brand_id, file_name, media_type, bytes, size_bytes, sha256, uploaded_by)
         values ($1, 'f', $2, decode(repeat('00', $3::int), 'hex'), $3, 'h', $4)`,
        [A, type, size, uid],
      )
    await asApp(async (c) => {
      const uid = await userId(c)
      await c.query('savepoint s1')
      expect(await code(() => insert(c, uid, 5242881, 'image/png'))).toBe('23514')
      await c.query('rollback to savepoint s1')
      expect(await code(() => insert(c, uid, 10, 'text/html'))).toBe('23514')
      await c.query('rollback to savepoint s1')
      await insert(c, uid, 5242880, 'image/png')
      await insert(c, uid, 10485761, 'application/pdf')
    })
  })

  it("refuses updating a verified fact's statement but allows its status", async () => {
    await asApp(async (c) => {
      await c.query('savepoint s1')
      expect(await code(() => c.query("update app.verified_fact set statement = 'x'"))).toBe('42501')
      await c.query('rollback to savepoint s1')
      const r = await c.query("update app.verified_fact set status = 'expired'")
      expect(r.rowCount).toBe(1)
    })
  })

  it('lets mkt_app decide a suggestion but not change what was proposed', async () => {
    await asApp(async (c) => {
      await c.query(
        `insert into app.suggestion (brand_id, step, key, proposed, why, confidence)
         values ($1, 'profile', 'tone', '"warm"', 'seen on the site', 'found')`,
        [A],
      )
      await c.query('savepoint s1')
      expect(
        await code(() => c.query(`update app.suggestion set proposed = '"cold"' where key = 'tone'`)),
      ).toBe('42501')
      await c.query('rollback to savepoint s1')
      expect(await code(() => c.query(`update app.suggestion set why = 'x' where key = 'tone'`))).toBe(
        '42501',
      )
      await c.query('rollback to savepoint s1')
      const r = await c.query(
        `update app.suggestion set decision = 'rejected', decided_at = now() where key = 'tone'`,
      )
      expect(r.rowCount).toBe(1)
    })
  })

  it('keeps one onboarding row per brand', async () => {
    await asApp(async (c) => {
      await c.query('insert into app.onboarding (brand_id) values ($1)', [A])
      expect(await code(() => c.query('insert into app.onboarding (brand_id) values ($1)', [A]))).toBe(
        '23505',
      )
    })
  })
})
