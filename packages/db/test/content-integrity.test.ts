import { requireDatabase } from '@mkt/test-support'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, versionRow, type RoleName, type TestDatabase } from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const ITEM = '00000000-0000-4000-8000-0000000000c1'
const OTHER_ITEM = '00000000-0000-4000-8000-0000000000c2'

type Actor = RoleName | 'migration' | 'superuser'

// Runs one statement as the given actor in a transaction with the brand set, then rolls back. Returns the
// error code, or 'ok'. The brand is set because the tables force row-level security: without it an owner sees
// no rows, and an update or delete would "succeed" on nothing without ever reaching a trigger.
async function attempt(db: TestDatabase, actor: Actor, sql: string, params: unknown[] = []): Promise<string> {
  // The superuser comes from the harness's admin pool; every other actor logs in as its own role.
  const pooled = actor === 'superuser' ? await db.admin.connect() : null
  const own = actor === 'superuser' ? null : new pg.Client({ connectionString: db.urlFor(actor) })
  if (own) await own.connect()
  const c = (pooled ?? own)!
  try {
    await c.query('begin')
    await c.query("select set_config('app.brand_id', $1, true)", [A])
    await c.query(sql, params)
    return 'ok'
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown'
  } finally {
    await c.query('rollback').catch(() => undefined)
    if (pooled) pooled.release()
    if (own) await own.end()
  }
}

describe('content versions cannot change and cannot lie about their hash', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    const c = new pg.Client({ connectionString: db.urlFor('migration') })
    await c.connect()
    try {
      await c.query('begin')
      await c.query("select set_config('app.brand_id', $1, true)", [A])
      await c.query("insert into app.brand (id, name, slug) values ($1, 'A', 'a')", [A])
      await c.query("insert into app.content_item (id, brand_id, kind) values ($1, $2, 'summary')", [ITEM, A])
      await c.query("insert into app.content_item (id, brand_id, kind) values ($1, $2, 'summary')", [
        OTHER_ITEM,
        A,
      ])
      const v = versionRow(A, ITEM)
      await c.query(
        "insert into app.content_version (brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by_kind) values ($1, $2, 1, $3, $4, 'cv1', 'system')",
        [A, ITEM, v.payload, v.hash],
      )
      await c.query('commit')
    } finally {
      await c.end()
    }
  })
  afterAll(async () => db?.drop())

  const actors: Actor[] = ['app', 'queue', 'audit_writer', 'owner_view', 'readonly', 'migration', 'superuser']

  it('can see the row it is about to try to change (so the refusals below are real)', async () => {
    const c = new pg.Client({ connectionString: db.urlFor('migration') })
    await c.connect()
    try {
      await c.query('begin')
      await c.query("select set_config('app.brand_id', $1, true)", [A])
      const result = await c.query('select count(*)::int as n from app.content_version')
      expect(result.rows[0].n).toBe(1)
    } finally {
      await c.query('rollback')
      await c.end()
    }
  })

  it('refuses an update, a delete and a truncate for every role, the table owner and the superuser (test 15)', async () => {
    for (const actor of actors) {
      expect(
        await attempt(db, actor, "update app.content_version set hash_scheme = 'cv2'"),
        `update ${actor}`,
      ).toBe('42501')
      expect(await attempt(db, actor, 'delete from app.content_version'), `delete ${actor}`).toBe('42501')
      expect(await attempt(db, actor, 'truncate app.content_version cascade'), `truncate ${actor}`).toBe(
        '42501',
      )
    }
  })

  it('refuses a hash that does not match the payload (test 16)', async () => {
    const v = versionRow(A, OTHER_ITEM)
    const insert =
      'insert into app.content_version (brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by_kind) values ($1, $2, 1, $3, $4, $5, $6)'
    expect(await attempt(db, 'app', insert, [A, OTHER_ITEM, v.payload, v.hash, 'cv1', 'system'])).toBe('ok')
    const wrong = 'sha256:' + '0'.repeat(64)
    expect(await attempt(db, 'app', insert, [A, OTHER_ITEM, v.payload, wrong, 'cv1', 'system'])).toBe('23514')
    expect(
      await attempt(db, 'app', insert, [A, OTHER_ITEM, v.payload, v.hash.toUpperCase(), 'cv1', 'system']),
    ).toBe('23514')
    expect(await attempt(db, 'app', insert, [A, OTHER_ITEM, v.payload + ' ', v.hash, 'cv1', 'system'])).toBe(
      '23514',
    )
    expect(await attempt(db, 'app', insert, [A, OTHER_ITEM, v.payload, v.hash, 'cv2', 'system'])).toBe(
      '23514',
    )
    // Text that is not JSON, with a hash that is right for it: refused because it is not JSON.
    const notJson = 'sha256:' + createHash('sha256').update('not json', 'utf8').digest('hex')
    expect(await attempt(db, 'app', insert, [A, OTHER_ITEM, 'not json', notJson, 'cv1', 'system'])).toBe(
      '23514',
    )
  })

  it('refuses a payload that names another brand or another item than its row (Review Focus 3)', async () => {
    const insert =
      'insert into app.content_version (brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by_kind) values ($1, $2, 1, $3, $4, $5, $6)'
    const elsewhere = versionRow(B, OTHER_ITEM)
    expect(
      await attempt(db, 'app', insert, [A, OTHER_ITEM, elsewhere.payload, elsewhere.hash, 'cv1', 'system']),
    ).toBe('23514')
    const wrongItem = versionRow(A, ITEM)
    expect(
      await attempt(db, 'app', insert, [A, OTHER_ITEM, wrongItem.payload, wrongItem.hash, 'cv1', 'system']),
    ).toBe('23514')
  })

  it('lets state, check results and provenance change without touching the version or its hash (test 17, database half)', async () => {
    const c = new pg.Client({ connectionString: db.urlFor('app') })
    await c.connect()
    try {
      await c.query('begin')
      await c.query("select set_config('app.brand_id', $1, true)", [A])
      const before = await c.query(
        'select hash, payload_canonical from app.content_version where number = 1 and content_item_id = $1',
        [ITEM],
      )
      const id = (await c.query('select id from app.content_version where content_item_id = $1', [ITEM]))
        .rows[0].id
      await c.query(
        "insert into app.content_version_state (content_version_id, brand_id, state) values ($1, $2, 'draft')",
        [id, A],
      )
      await c.query(
        "update app.content_version_state set state = 'awaiting_approval' where content_version_id = $1",
        [id],
      )
      await c.query(
        "insert into app.check_result (brand_id, content_version_id, check_name, kind, passed) values ($2, $1, 'accuracy', 'blocking', true)",
        [id, A],
      )
      const after = await c.query('select hash, payload_canonical from app.content_version where id = $1', [
        id,
      ])
      expect(after.rows[0]).toEqual(before.rows[0])
      // The same payload under another provenance gets the same hash.
      const v = versionRow(A, OTHER_ITEM)
      const insert =
        "insert into app.content_version (brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, provenance, created_by_kind) values ($1, $2, $3, $4, $5, 'cv1', $6, 'system') returning hash"
      const one = await c.query(insert, [A, OTHER_ITEM, 1, v.payload, v.hash, JSON.stringify({ run: 'one' })])
      const two = await c.query(insert, [A, OTHER_ITEM, 2, v.payload, v.hash, JSON.stringify({ run: 'two' })])
      expect(one.rows[0].hash).toBe(two.rows[0].hash)
    } finally {
      await c.query('rollback').catch(() => undefined)
      await c.end()
    }
  })
})
