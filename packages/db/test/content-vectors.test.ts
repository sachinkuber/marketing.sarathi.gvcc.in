import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VECTORS } from '../../canonical/test/vectors.ts'
import { createTestDatabase, type TestDatabase } from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const ITEM = '00000000-0000-4000-8000-0000000000c1'

describe('the database accepts every accepted test vector and refuses a wrong hash (test 14, database half)', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
  })
  afterAll(async () => db?.drop())

  const accepted = VECTORS.filter((v) => v.canonical !== undefined)
  expect(accepted.length).toBeGreaterThanOrEqual(6)

  for (const vector of accepted) {
    it(vector.name, async () => {
      const c = new pg.Client({ connectionString: db.urlFor('migration') })
      await c.connect()
      try {
        await c.query('begin')
        await c.query("select set_config('app.brand_id', $1, true)", [A])
        await c.query("insert into app.brand (id, name, slug) values ($1, 'A', 'a')", [A])
        await c.query("insert into app.content_item (id, brand_id, kind) values ($1, $2, 'summary')", [
          ITEM,
          A,
        ])
        const insert =
          "insert into app.content_version (brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by_kind) values ($1, $2, 1, $3, $4, 'cv1', 'system')"
        await c.query('savepoint good')
        await c.query(insert, [A, ITEM, vector.canonical, vector.hash])
        await c.query('rollback to savepoint good')
        const wrong = vector.hash!.slice(0, -1) + (vector.hash!.endsWith('0') ? '1' : '0')
        await expect(c.query(insert, [A, ITEM, vector.canonical, wrong])).rejects.toMatchObject({
          code: '23514',
        })
      } finally {
        await c.query('rollback').catch(() => undefined)
        await c.end()
      }
    })
  }
})
