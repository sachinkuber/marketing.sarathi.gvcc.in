import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../src/testing.ts'

describe('test database', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
  })
  afterAll(async () => db.drop())

  it('is migrated, with the schemas the spec names that exist so far', async () => {
    const result = await db.admin.query(
      "select schema_name from information_schema.schemata where schema_name in ('app','audit','secrets') order by 1",
    )
    expect(result.rows.map((r) => r.schema_name)).toEqual(['app', 'audit'])
  })

  it('has seven roles and none of them is a superuser or bypasses row-level security', async () => {
    const result = await db.admin.query(
      "select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname like 'mkt\\_%' order by 1",
    )
    const byName: Record<string, { rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }> =
      Object.fromEntries(result.rows.map((r) => [r.rolname, r]))
    expect(Object.keys(byName).sort()).toEqual([
      'mkt_app',
      'mkt_audit_writer',
      'mkt_definer',
      'mkt_migration',
      'mkt_owner_view',
      'mkt_queue',
      'mkt_readonly',
    ])
    for (const [name, role] of Object.entries(byName)) {
      expect(role.rolsuper, name).toBe(false)
      expect(role.rolbypassrls, name).toBe(false)
    }
    expect(byName.mkt_definer?.rolcanlogin).toBe(false)
  })

  it('lets the application role connect and refuses it creating a table', async () => {
    const client = new pg.Client({ connectionString: db.urlFor('app') })
    await client.connect()
    try {
      await expect(client.query('create table app.nope (id int)')).rejects.toMatchObject({ code: '42501' })
    } finally {
      await client.end()
    }
  })
})
