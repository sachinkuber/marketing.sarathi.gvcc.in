import { requireDatabase } from '@mkt/test-support'
import { readFileSync } from 'node:fs'
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

  // Everything in the namespace, so an object a later migration leaks into `auth` (for example through
  // a search_path left set) fails here.
  it('holds the five tables and their indexes and nothing else: no functions, sequences or types', async () => {
    const relations = await db.admin.query(
      `select c.relname, c.relkind, coalesce(t.relname, c.relname) as on_table
         from pg_class c
         left join pg_index i on i.indexrelid = c.oid
         left join pg_class t on t.oid = i.indrelid
        where c.relnamespace = 'auth'::regnamespace
        order by c.relkind, c.relname`,
    )
    const of = (kind: string) => relations.rows.filter((r) => r.relkind === kind).map((r) => r.relname)
    expect(relations.rows.filter((r) => !['r', 'i'].includes(r.relkind))).toEqual([])
    expect(of('r').sort()).toEqual([...TABLES].sort())
    expect(of('i')).toEqual([
      'account_issuer_accountId_uidx',
      'account_pkey',
      'account_userId_idx',
      'session_pkey',
      'session_token_key',
      'session_userId_idx',
      'twoFactor_pkey',
      'twoFactor_secret_idx',
      'twoFactor_userId_idx',
      'user_email_key',
      'user_pkey',
      'verification_identifier_idx',
      'verification_pkey',
    ])
    for (const row of relations.rows) expect(TABLES, row.relname).toContain(row.on_table)

    const functions = await db.admin.query(
      "select proname from pg_proc where pronamespace = 'auth'::regnamespace",
    )
    expect(functions.rows).toEqual([])
    // Each table brings its own row type and array type; anything else is a type someone created.
    const types = await db.admin.query(
      `select t.typname from pg_type t
        where t.typnamespace = 'auth'::regnamespace
          and not exists (select 1 from pg_class c where c.reltype in (t.oid, t.typelem))`,
    )
    expect(types.rows).toEqual([])
  })

  it('puts search_path back after the generated SQL, so later migrations in one transaction do not run in auth', () => {
    const sql = readFileSync(new URL('../migrations/0006_auth_schema.sql', import.meta.url), 'utf8')
    const up = sql.split('-- Down Migration')[0] ?? ''
    const set = up.lastIndexOf('set local search_path to auth;')
    const reset = up.lastIndexOf('set local search_path to default;')
    expect(set).toBeGreaterThan(-1)
    expect(reset).toBeGreaterThan(up.indexOf('-- END generated'))
    expect(reset).toBeGreaterThan(set)
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
