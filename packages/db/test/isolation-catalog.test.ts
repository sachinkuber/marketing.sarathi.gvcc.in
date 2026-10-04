import { requireDatabase } from '@mkt/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../src/testing.ts'

const POLICY = "(brand_id = (current_setting('app.brand_id'::text, true))::uuid)"

describe('every brand-scoped table follows the rules (acceptance tests 3 and 4)', () => {
  let db: TestDatabase
  let scoped: string[]
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    const r = await db.admin.query(
      "select table_name from information_schema.columns where table_schema = 'app' and column_name = 'brand_id' order by 1",
    )
    scoped = r.rows.map((x) => x.table_name)
  })
  afterAll(async () => db.drop())

  it('finds the brand-scoped tables, so the tests below cannot pass on an empty list', () => {
    expect(scoped.length).toBeGreaterThanOrEqual(15)
    expect(scoped).toContain('content_version')
    expect(scoped).not.toContain('brand')
  })

  it('has row-level security enabled and forced on each', async () => {
    const r = await db.admin.query(
      "select relname, relrowsecurity, relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r' and c.relname = any($1)",
      [scoped],
    )
    expect(r.rowCount).toBe(scoped.length)
    for (const row of r.rows) {
      expect(row.relrowsecurity, row.relname).toBe(true)
      expect(row.relforcerowsecurity, row.relname).toBe(true)
    }
  })

  it('has one policy brand_isolation per table with the same read and write condition', async () => {
    const r = await db.admin.query(
      "select tablename, policyname, qual, with_check, cmd from pg_policies where schemaname = 'app' and tablename = any($1) and policyname = 'brand_isolation'",
      [scoped],
    )
    expect(r.rowCount).toBe(scoped.length)
    for (const row of r.rows) {
      expect(row.cmd, row.tablename).toBe('ALL')
      expect(row.qual, row.tablename).toBe(POLICY)
      expect(row.with_check, row.tablename).toBe(POLICY)
    }
  })

  it('has a unique key on (brand_id, id) wherever a table has an id', async () => {
    const withId = await db.admin.query(
      "select table_name from information_schema.columns where table_schema = 'app' and column_name = 'id' and table_name = any($1)",
      [scoped],
    )
    expect(withId.rowCount).toBeGreaterThanOrEqual(13)
    for (const { table_name } of withId.rows) {
      const r = await db.admin.query(
        `select 1 from pg_constraint c where c.conrelid = ('app.' || $1)::regclass and c.contype = 'u'
           and (select array_agg(a.attname::text order by a.attname) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) = array['brand_id','id']`,
        [table_name],
      )
      expect(r.rowCount, table_name).toBe(1)
    }
  })

  it('has brand_id in every foreign key between brand-scoped tables, on both sides', async () => {
    const r = await db.admin.query(
      `select c.conname, c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
              array(select a.attname::text from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) as child_cols,
              array(select a.attname::text from pg_attribute a where a.attrelid = c.confrelid and a.attnum = any(c.confkey)) as parent_cols
         from pg_constraint c
        where c.contype = 'f' and c.connamespace = 'app'::regnamespace`,
    )
    const names = new Set(scoped.map((t) => `app.${t}`))
    const between = r.rows.filter((x) => names.has(x.child) && names.has(x.parent))
    expect(between.length).toBeGreaterThanOrEqual(10)
    for (const fk of between) {
      expect(fk.child_cols, `${fk.conname} child`).toContain('brand_id')
      expect(fk.parent_cols, `${fk.conname} parent`).toContain('brand_id')
    }
  })
})
