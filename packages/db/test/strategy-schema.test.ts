import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase } from '@mkt/test-support'
import { createTestDatabase, seedBrand, type TestDatabase } from '../src/testing.ts'
import { withBrand } from '../src/with-brand.ts'

const A = '11111111-1111-4111-8111-111111111111'
let db: TestDatabase
let userA: string

beforeAll(async () => {
  await requireDatabase()
  db = await createTestDatabase()
  await seedBrand(db, A, 'brand-a')
  userA = (
    await db.admin.query<{ user_id: string }>('select user_id from app.membership where brand_id = $1', [A])
  ).rows[0]!.user_id
})
afterAll(async () => {
  await db?.drop()
})

const code = async (run: () => Promise<unknown>): Promise<string | null> =>
  run().then(
    () => null,
    (e: { code?: string }) => e.code ?? 'no_code',
  )

// Runs `fn` as the given role with the brand set, in a transaction that is rolled back.
async function inTx<T>(role: 'app' | 'migration', fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: db.urlFor(role) })
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

const addItem = (c: pg.Client, kind: string) =>
  c.query('insert into app.content_item (brand_id, kind) values ($1, $2::app.content_kind)', [A, kind])

describe('strategy brief schema', () => {
  it('a waiting version can be invalidated', async () => {
    await inTx('migration', async (c) => {
      const v = await c.query<{ id: string }>('select id from app.content_version where brand_id = $1', [A])
      const id = v.rows[0]!.id
      await c.query(
        "insert into app.content_version_state (content_version_id, brand_id, state) values ($1, $2, 'draft')",
        [id, A],
      )
      await c.query('alter table app.content_version_state disable trigger version_state_transition')
      await c.query(
        "update app.content_version_state set state = 'awaiting_approval' where content_version_id = $1",
        [id],
      )
      await c.query('alter table app.content_version_state enable trigger version_state_transition')
      await c.query(
        "update app.content_version_state set state = 'invalidated' where content_version_id = $1",
        [id],
      )
      const r = await c.query('select state from app.content_version_state where content_version_id = $1', [
        id,
      ])
      expect(r.rows[0].state).toBe('invalidated')
    })
  })

  it('a brand has at most one strategy brief item', async () => {
    await inTx('migration', async (c) => {
      await addItem(c, 'strategy_brief')
      await c.query('savepoint s')
      expect(await code(() => addItem(c, 'strategy_brief'))).toBe('23505')
      await c.query('rollback to savepoint s')
      expect(await code(() => addItem(c, 'summary'))).toBeNull()
      expect(await code(() => addItem(c, 'summary'))).toBeNull()
    })
  })
})

describe('add_evaluation_case', () => {
  let app: pg.Pool
  beforeAll(() => {
    app = new pg.Pool({ connectionString: db.urlFor('app') })
  })
  afterAll(async () => {
    await app?.end()
  })

  // As the app calls it: inside the brand's transaction (withBrand), naming that brand unless `brand` says otherwise.
  const call = (agent: string, body: unknown, creator: string | null = userA, brand: string = A) =>
    withBrand(app, A, (c) =>
      c.query('select app.add_evaluation_case($1, $2, $3::jsonb, $4) as id', [
        agent,
        brand,
        body === null ? null : JSON.stringify(body),
        creator,
      ]),
    )

  it('add_evaluation_case stores a candidate', async () => {
    const r = await call('research', { suggestionId: 'stores-1', note: 'n' })
    const id = r.rows[0].id as string
    const row = await db.admin.query(
      'select agent, status, subject_brand_id, created_by, body from app.evaluation_case where id = $1',
      [id],
    )
    expect(row.rows[0]).toMatchObject({
      agent: 'research',
      status: 'candidate',
      subject_brand_id: A,
      created_by: userA,
    })
    expect(row.rows[0].body).toEqual({ suggestionId: 'stores-1', note: 'n' })
  })

  it('add_evaluation_case refuses a bad agent name and a body over 16 KB', async () => {
    expect(await code(() => call('Research', { a: 1 }))).toBe('22023')
    expect(await code(() => call('r', { a: 1 }))).toBe('22023')
    expect(await code(() => call('research', { text: 'x'.repeat(16400) }))).toBe('22023')
    expect(await code(() => call('research', null))).toBe('22023')
    expect(await code(() => call('research', { a: 1 }, null))).toBe('22023')
  })

  it('add_evaluation_case refuses a brand other than the brand of the transaction', async () => {
    const before = await db.admin.query('select count(*)::int as n from app.evaluation_case')
    // Another brand than the one the transaction is set to.
    expect(await code(() => call('research', { a: 1 }, userA, '22222222-2222-4222-8222-222222222222'))).toBe(
      '22023',
    )
    // No brand set at all.
    expect(
      await code(() =>
        app.query('select app.add_evaluation_case($1, $2, $3::jsonb, $4) as id', [
          'research',
          A,
          JSON.stringify({ a: 1 }),
          userA,
        ]),
      ),
    ).toBe('22023')
    const after = await db.admin.query('select count(*)::int as n from app.evaluation_case')
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('add_evaluation_case refuses the same suggestion twice', async () => {
    await call('research', { suggestionId: 'twice-1' })
    expect(await code(() => call('research', { suggestionId: 'twice-1' }))).toBe('23505')
    // A dropped case frees the suggestion.
    await db.admin.query(
      "update app.evaluation_case set status = 'dropped' where body ->> 'suggestionId' = 'twice-1'",
    )
    expect(await code(() => call('research', { suggestionId: 'twice-1' }))).toBeNull()
  })

  it('mkt_app still cannot read or write evaluation_case directly', async () => {
    expect(await code(() => app.query('select 1 from app.evaluation_case'))).toBe('42501')
    expect(
      await code(() =>
        app.query(
          "insert into app.evaluation_case (agent, status, body, created_by) values ('a', 'candidate', '{}', $1)",
          [userA],
        ),
      ),
    ).toBe('42501')
  })
})
