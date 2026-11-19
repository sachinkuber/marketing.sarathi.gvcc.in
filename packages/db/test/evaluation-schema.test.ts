import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase } from '@mkt/test-support'
import { brandScopedTables } from '../src/isolation-probes.ts'
import { createTestDatabase, type TestDatabase } from '../src/testing.ts'

const TABLES = ['evaluation_run', 'evaluation_result', 'evaluation_case']
let db: TestDatabase

beforeAll(async () => {
  await requireDatabase()
  db = await createTestDatabase()
})
afterAll(async () => {
  await db?.drop()
})

async function as<T>(role: 'app' | 'owner_view', fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: db.urlFor(role) })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const code = async (run: () => Promise<unknown>): Promise<string | null> =>
  run().then(
    () => null,
    (e: { code?: string }) => e.code ?? 'no_code',
  )

describe('evaluation tables', () => {
  it('creates the three tables', async () => {
    const r = await db.admin.query(
      `select table_name from information_schema.tables where table_schema = 'app' and table_name = any($1)`,
      [TABLES],
    )
    expect(r.rows.map((x: { table_name: string }) => x.table_name).sort()).toEqual([...TABLES].sort())
  })

  it('has no brand_id column and is not listed as brand scoped', async () => {
    const cols = await db.admin.query(
      `select table_name from information_schema.columns
       where table_schema = 'app' and table_name = any($1) and column_name = 'brand_id'`,
      [TABLES],
    )
    expect(cols.rows).toEqual([])
    const scoped = await brandScopedTables(db.admin)
    for (const t of TABLES) expect(scoped).not.toContain(t)
  })

  it('refuses mkt_app every read', async () => {
    await as('app', async (c) => {
      for (const t of TABLES) expect(await code(() => c.query(`select 1 from app.${t}`))).toBe('42501')
    })
  })

  it('lets mkt_owner_view read but not write', async () => {
    await as('owner_view', async (c) => {
      for (const t of TABLES) await c.query(`select 1 from app.${t}`)
      expect(
        await code(() =>
          c.query(
            `insert into app.evaluation_run (agent, version, files_hash, sets_hash, model) values ('a', 1, 'h', 's', 'm')`,
          ),
        ),
      ).toBe('42501')
    })
  })

  it('records a run with results, and links it to an agent version', async () => {
    const run = await db.admin.query(
      `insert into app.evaluation_run (agent, version, files_hash, sets_hash, model)
       values ('a', 1, 'h', 's', 'm') returning id, hostile_total, cost_usd_micros`,
    )
    expect(run.rows[0].hostile_total).toBe(0)
    await db.admin.query(
      `insert into app.evaluation_result (run_id, case_id, hostile, passed, checks, input_tokens, output_tokens)
       values ($1, 'c1', true, true, '{}', 1, 1)`,
      [run.rows[0].id],
    )
    const res = await db.admin.query('select searches from app.evaluation_result')
    expect(res.rows[0].searches).toBe(0)
    await db.admin.query(
      `insert into app.agent_definition_version (agent, version, model, effort, files_hash, evaluation_run_id)
       values ('a', 1, 'm', 'low', 'h', $1)`,
      [run.rows[0].id],
    )
  })

  it('limits a candidate case to its three statuses', async () => {
    const user = await db.admin.query('select gen_random_uuid() as id')
    const insert = (status: string) =>
      db.admin.query(
        `insert into app.evaluation_case (agent, status, body, created_by) values ('a', $1, '{}', $2)`,
        [status, user.rows[0].id],
      )
    expect(await code(() => insert('bogus'))).toBe('23514')
    await insert('candidate')
  })
})
