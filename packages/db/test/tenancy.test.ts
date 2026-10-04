import { requireDatabase } from '@mkt/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../src/testing.ts'

describe('tenancy tables', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
  })
  afterAll(async () => db.drop())

  it('has every enumerated type from the schema document', async () => {
    const result = await db.admin.query(
      "select typname from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'app' and t.typtype = 'e' order by 1",
    )
    expect(result.rows.map((r) => r.typname)).toEqual([
      'action_state',
      'actor_kind',
      'approval_decision',
      'attempt_state',
      'brand_status',
      'check_kind',
      'content_kind',
      'job_class',
      'kill_scope',
      'membership_role',
      'model_call_status',
      'notification_state',
      'popup_choice',
      'run_state',
      'version_state',
    ])
  })

  it('has the six tenancy tables', async () => {
    const result = await db.admin.query("select tablename from pg_tables where schemaname = 'app' order by 1")
    expect(result.rows.map((r) => r.tablename)).toEqual(
      expect.arrayContaining([
        'approval_setting',
        'brand',
        'invite',
        'kill_switch',
        'membership',
        'platform_owner',
      ]),
    )
  })

  it('refuses a second active kill switch for the same brand, scope and target', async () => {
    const client = await db.admin.connect()
    try {
      await client.query('begin')
      await client.query('set local role mkt_migration')
      await client.query("select set_config('app.brand_id', '00000000-0000-4000-8000-0000000000a1', true)")
      await client.query(
        "insert into app.brand (id, name, slug) values ('00000000-0000-4000-8000-0000000000a1','A','a')",
      )
      const kill =
        "insert into app.kill_switch (brand_id, scope, target, active, set_by) values ('00000000-0000-4000-8000-0000000000a1','channel','instagram',true,gen_random_uuid())"
      await client.query(kill)
      await expect(client.query(kill)).rejects.toMatchObject({ code: '23505' })
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
  })

  it('refuses a slug with capitals', async () => {
    const client = await db.admin.connect()
    try {
      await client.query('begin')
      await client.query('set local role mkt_migration')
      await client.query("select set_config('app.brand_id', '00000000-0000-4000-8000-0000000000b1', true)")
      await expect(
        client.query(
          "insert into app.brand (id, name, slug) values ('00000000-0000-4000-8000-0000000000b1','B','Bad Slug')",
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
  })

  it('refuses a reminder count outside 1 to 5', async () => {
    const client = await db.admin.connect()
    try {
      await client.query('begin')
      await client.query('set local role mkt_migration')
      await client.query("select set_config('app.brand_id', '00000000-0000-4000-8000-0000000000b2', true)")
      await client.query(
        "insert into app.brand (id, name, slug) values ('00000000-0000-4000-8000-0000000000b2','B','b-two')",
      )
      await expect(
        client.query(
          "insert into app.approval_setting (brand_id, reminder_count) values ('00000000-0000-4000-8000-0000000000b2', 6)",
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
  })
})
