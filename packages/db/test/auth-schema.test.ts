import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, seedBrand, type TestDatabase } from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const TABLES = ['account', 'session', 'twoFactor', 'user', 'verification']

describe('the auth schema', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    await seedBrand(db, A, 'brand-a')
  })
  afterAll(async () => db.drop())

  it('has exactly the sign-in library tables, so a library upgrade that adds one is a deliberate change', async () => {
    const result = await db.admin.query(
      "select table_name from information_schema.tables where table_schema = 'auth' and table_type = 'BASE TABLE'",
    )
    expect(result.rows.map((r) => r.table_name).sort()).toEqual([...TABLES].sort())
  })

  it('uses uuid for the user ID, so our tables can reference it', async () => {
    const result = await db.admin.query(
      "select data_type from information_schema.columns where table_schema = 'auth' and table_name = 'user' and column_name = 'id'",
    )
    expect(result.rows[0].data_type).toBe('uuid')
  })

  it('lets the application role read and write every table', async () => {
    for (const table of TABLES) {
      for (const privilege of ['select', 'insert', 'update', 'delete']) {
        const result = await db.admin.query('select has_table_privilege($1, $2, $3) as ok', [
          'mkt_app',
          `auth."${table}"`,
          privilege,
        ])
        expect(result.rows[0].ok, `${table} ${privilege}`).toBe(true)
      }
    }
  })

  it('gives no other run-time role any right, so password hashes are not readable by them', async () => {
    for (const role of ['mkt_readonly', 'mkt_queue', 'mkt_audit_writer', 'mkt_owner_view']) {
      for (const table of TABLES) {
        const result = await db.admin.query('select has_table_privilege($1, $2, $3) as ok', [
          role,
          `auth."${table}"`,
          'select',
        ])
        expect(result.rows[0].ok, `${role} ${table}`).toBe(false)
      }
    }
  })

  it('refuses the application role creating or altering anything in the schema', async () => {
    const client = new pg.Client({ connectionString: db.urlFor('app') })
    await client.connect()
    try {
      await expect(client.query('create table auth.nope (id int)')).rejects.toMatchObject({ code: '42501' })
      await expect(client.query('alter table auth."user" add column nope int')).rejects.toMatchObject({
        code: '42501',
      })
    } finally {
      await client.end()
    }
  })

  it('references auth.user from the eight columns the schema document names, and enforces it', async () => {
    const result = await db.admin.query(
      `select count(*)::int as n from pg_constraint
        where contype = 'f' and confrelid = 'auth."user"'::regclass and conrelid::regclass::text like 'app.%'`,
    )
    expect(result.rows[0].n).toBe(8)
    await expect(
      db.admin.query(
        "insert into app.membership (brand_id, user_id, role) values ($1, gen_random_uuid(), 'viewer')",
        [A],
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })
})
