import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type RoleName, type TestDatabase } from '../src/testing.ts'

async function query(db: TestDatabase, role: RoleName, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: db.urlFor(role) })
  await client.connect()
  try {
    return await client.query(sql, params)
  } finally {
    await client.end()
  }
}

describe('the worker heartbeat', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
  })
  afterAll(async () => db?.drop())

  it('stamp_worker upserts and worker_last_seen returns the newest', async () => {
    expect((await query(db, 'app', 'select app.worker_last_seen() as seen')).rows[0].seen).toBeNull()
    await query(db, 'app', "select app.stamp_worker('worker-a')")
    await db.admin.query("update app.worker_heartbeat set seen_at = now() - interval '1 hour'")
    await query(db, 'app', "select app.stamp_worker('worker-b')")
    await db.admin.query(
      "update app.worker_heartbeat set seen_at = now() - interval '30 minutes' where worker_id = 'worker-b'",
    )
    // Stamping again moves the row to now, and does not add a second row for the same worker.
    await query(db, 'app', "select app.stamp_worker('worker-a')")
    const rows = await db.admin.query('select worker_id from app.worker_heartbeat order by 1')
    expect(rows.rows.map((r) => r.worker_id)).toEqual(['worker-a', 'worker-b'])
    const seen = await query(
      db,
      'app',
      "select (now() - app.worker_last_seen()) < interval '1 minute' as fresh",
    )
    expect(seen.rows[0].fresh).toBe(true)
  })

  it('refuses an id over 200 characters and an empty one', async () => {
    await expect(query(db, 'app', 'select app.stamp_worker($1)', ['x'.repeat(201)])).rejects.toMatchObject({
      code: '22023',
    })
    await expect(query(db, 'app', 'select app.stamp_worker($1)', [''])).rejects.toMatchObject({
      code: '22023',
    })
    await query(db, 'app', 'select app.stamp_worker($1)', ['y'.repeat(200)])
  })

  it('mkt_queue and mkt_owner_view cannot call stamp_worker', async () => {
    for (const role of ['queue', 'owner_view'] as const) {
      await expect(query(db, role, "select app.stamp_worker('w')"), role).rejects.toMatchObject({
        code: '42501',
      })
    }
  })

  it('keeps the table out of the application role reach', async () => {
    await expect(query(db, 'app', 'select * from app.worker_heartbeat')).rejects.toMatchObject({
      code: '42501',
    })
  })
})
