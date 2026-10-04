import { requireDatabase } from '@mkt/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../src/testing.ts'

describe('content and approval tables', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
  })
  afterAll(async () => db.drop())

  it('has the eleven content and approval tables as well as the six tenancy tables', async () => {
    const result = await db.admin.query("select tablename from pg_tables where schemaname = 'app' order by 1")
    expect(result.rows.map((r) => r.tablename)).toEqual([
      'approval',
      'approval_invalidation',
      'approval_request',
      'approval_setting',
      'asset',
      'brand',
      'check_result',
      'content_item',
      'content_version',
      'content_version_state',
      'content_version_state_change',
      'invite',
      'kill_switch',
      'membership',
      'outbox_action',
      'platform_owner',
      'popup_ack',
    ])
  })

  it('refuses a blocking check carrying a score', async () => {
    const { client, brand, version } = await withVersion(db)
    try {
      await expect(
        client.query(
          "insert into app.check_result (brand_id, content_version_id, check_name, kind, passed, score) values ($1,$2,'accuracy','blocking',true,4)",
          [brand, version],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
  })

  it('refuses a score check with neither a score nor a not-applicable reason', async () => {
    const { client, brand, version } = await withVersion(db)
    try {
      await expect(
        client.query(
          "insert into app.check_result (brand_id, content_version_id, check_name, kind) values ($1,$2,'brand_voice','score')",
          [brand, version],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
  })

  it('accepts a score check marked not applicable with a reason', async () => {
    const { client, brand, version } = await withVersion(db)
    try {
      await client.query(
        "insert into app.check_result (brand_id, content_version_id, check_name, kind, not_applicable, not_applicable_reason) values ($1,$2,'visual_quality','score',true,'text-only item')",
        [brand, version],
      )
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
  })
})

async function withVersion(db: TestDatabase) {
  const client = await db.admin.connect()
  const brand = '00000000-0000-4000-8000-0000000000c1'
  const item = '00000000-0000-4000-8000-0000000000c2'
  const version = '00000000-0000-4000-8000-0000000000c3'
  await client.query('begin')
  await client.query('set local role mkt_migration')
  await client.query("select set_config('app.brand_id', $1, true)", [brand])
  await client.query("insert into app.brand (id, name, slug) values ($1,'C','c-brand')", [brand])
  await client.query("insert into app.content_item (id, brand_id, kind) values ($1,$2,'summary')", [
    item,
    brand,
  ])
  await client.query(
    "insert into app.content_version (id, brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by_kind) values ($1,$2,$3,1,'{}','sha256:x','cv1','system')",
    [version, brand, item],
  )
  await client.query('savepoint a')
  return { client, brand, version }
}
