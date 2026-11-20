import pg from 'pg'
import { runner } from 'node-pg-migrate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase } from '@mkt/test-support'
import { migrate } from '../src/migrate.ts'
import { createTestDatabase, seedBrand, type TestDatabase } from '../src/testing.ts'

const A = '11111111-1111-4111-8111-111111111111'
let db: TestDatabase

beforeAll(async () => {
  await requireDatabase()
  db = await createTestDatabase()
  await seedBrand(db, A, 'brand-a')
})
afterAll(async () => {
  await db?.drop()
})

const code = async (run: () => Promise<unknown>): Promise<string | null> =>
  run().then(
    () => null,
    (e: { code?: string }) => e.code ?? 'no_code',
  )

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

describe('migration 0025: research ledger and knowledge carry-overs', () => {
  it('model calls carry search and fetch counts', async () => {
    // Both columns are not null and default to 0, so an insert that omits them reads back 0 and 0.
    const cols = await db.admin.query(
      `select column_name, column_default, is_nullable from information_schema.columns
        where table_schema = 'app' and table_name = 'model_call' and column_name in ('server_tool_searches','server_tool_fetches')
        order by 1`,
    )
    expect(cols.rows).toEqual([
      { column_name: 'server_tool_fetches', column_default: '0', is_nullable: 'NO' },
      { column_name: 'server_tool_searches', column_default: '0', is_nullable: 'NO' },
    ])
  })

  it('research_source refuses an unknown result', async () => {
    await asApp(async (c) => {
      const insert = (result: string) =>
        c.query(
          "insert into app.research_source (brand_id, kind, result, extract) values ($1, 'owner_statement', $2, 'x')",
          [A, result],
        )
      await c.query('savepoint s1')
      expect(await code(() => insert('owner_statement'))).toBe('23514')
      await c.query('rollback to savepoint s1')
      for (const ok of ['read', 'blocked', 'empty', 'error', 'stated']) await insert(ok)
    })
  })

  it("a document's size must match its bytes", async () => {
    await asApp(async (c) => {
      const uid = await userId(c)
      const insert = (size: number) =>
        c.query(
          `insert into app.brand_document (brand_id, file_name, media_type, bytes, size_bytes, sha256, uploaded_by)
           values ($1, 'f', 'application/pdf', '\\x01020304', $2, 'h', $3)`,
          [A, size, uid],
        )
      await c.query('savepoint s1')
      expect(await code(() => insert(5))).toBe('23514')
      await c.query('rollback to savepoint s1')
      await insert(4)
    })
  })

  it('the database refuses a 6 MB image and accepts a 50 MB PDF', async () => {
    await asApp(async (c) => {
      const uid = await userId(c)
      const insert = (type: string, size: number) =>
        c.query(
          `insert into app.brand_document (brand_id, file_name, media_type, bytes, size_bytes, sha256, uploaded_by)
           values ($1, 'f', $2, decode(repeat('00', $3::int), 'hex'), $3, 'h', $4)`,
          [A, type, size, uid],
        )
      const MB = 1048576
      await c.query('savepoint s1')
      expect(await code(() => insert('image/jpeg', 6 * MB))).toBe('23514')
      await c.query('rollback to savepoint s1')
      await insert('application/pdf', 50 * MB)
    })
  })

  it('lets mkt_app delete an unreferenced document but not a referenced one', async () => {
    await asApp(async (c) => {
      const uid = await userId(c)
      const doc = async (): Promise<string> =>
        (
          await c.query(
            `insert into app.brand_document (brand_id, file_name, media_type, bytes, size_bytes, sha256, uploaded_by)
             values ($1, 'f', 'application/pdf', '\\x01', 1, 'h', $2) returning id`,
            [A, uid],
          )
        ).rows[0].id as string
      const free = await doc()
      expect((await c.query('delete from app.brand_document where id = $1', [free])).rowCount).toBe(1)
      const used = await doc()
      await c.query(
        "insert into app.research_source (brand_id, kind, document_id, result, extract) values ($1, 'document', $2, 'read', 'x')",
        [A, used],
      )
      await c.query('savepoint s1')
      expect(await code(() => c.query('delete from app.brand_document where id = $1', [used]))).toBe('23503')
    })
  })

  it('profile_item can be superseded but not rewritten', async () => {
    await asApp(async (c) => {
      const mk = async (key: string): Promise<string> =>
        (
          await c.query(
            `insert into app.profile_item (brand_id, key, value, status) values ($1, $2, '"v"', 'found') returning id`,
            [A, key],
          )
        ).rows[0].id as string
      const old = await mk('tagline')
      const next = await mk('tagline')
      const r = await c.query('update app.profile_item set superseded_by = $1 where id = $2', [next, old])
      expect(r.rowCount).toBe(1)
      await c.query('savepoint s1')
      expect(
        await code(() => c.query(`update app.profile_item set value = '"w"' where id = $1`, [old])),
      ).toBe('42501')
    })
  })

  it('onboarding and job_input carry the new columns', async () => {
    const r = await db.admin.query(
      `select table_name, column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'app' and (
          (table_name = 'onboarding' and column_name in ('intake','research_run_id'))
          or (table_name = 'job_input' and column_name in ('agent','files_hash'))
          or (table_name = 'model_price' and column_name = 'search_micros'))
        order by 1, 2`,
    )
    expect(r.rows).toEqual([
      { table_name: 'job_input', column_name: 'agent', data_type: 'text', is_nullable: 'YES' },
      { table_name: 'job_input', column_name: 'files_hash', data_type: 'text', is_nullable: 'YES' },
      { table_name: 'model_price', column_name: 'search_micros', data_type: 'bigint', is_nullable: 'YES' },
      { table_name: 'onboarding', column_name: 'intake', data_type: 'jsonb', is_nullable: 'YES' },
      { table_name: 'onboarding', column_name: 'research_run_id', data_type: 'uuid', is_nullable: 'YES' },
    ])
  })

  it('the sonnet price has a search price', async () => {
    const own = await createTestDatabase()
    try {
      const url = own.urlFor('migration')
      const base = {
        databaseUrl: url,
        dir: new URL('../migrations', import.meta.url).pathname,
        migrationsTable: 'pgmigrations',
        migrationsSchema: 'public',
        createSchema: false,
        log: () => undefined,
      }
      // Take 0026 and 0025 off, price two models, apply them again: only the sonnet rows gain a search price.
      await runner({ ...base, direction: 'down', count: 2 })
      for (const [model, from] of [
        ['claude-sonnet-5-5', '2026-01-01'],
        ['claude-sonnet-5-5', '2026-06-01'],
        ['claude-opus-5-5', '2026-01-01'],
      ] as const) {
        await own.admin.query(
          `insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, source)
           values ($1, $2, 1, 1, 1, 1, 'test')`,
          [model, from],
        )
      }
      await migrate(url)
      const r = await own.admin.query(
        'select model, search_micros::text as s from app.model_price order by model, effective_from',
      )
      expect(r.rows).toEqual([
        { model: 'claude-opus-5-5', s: null },
        { model: 'claude-sonnet-5-5', s: '10000' },
        { model: 'claude-sonnet-5-5', s: '10000' },
      ])
    } finally {
      await own.drop()
    }
  })
})
