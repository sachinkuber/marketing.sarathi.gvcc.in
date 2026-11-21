import pg from 'pg'
import { runner } from 'node-pg-migrate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase } from '@mkt/test-support'
import { createTestDatabase, seedBrand, seedDefinition, seedRun, type TestDatabase } from '../src/testing.ts'

const A = '11111111-1111-4111-8111-111111111111'
let db: TestDatabase

beforeAll(async () => {
  await requireDatabase()
  db = await createTestDatabase()
  await seedBrand(db, A, 'brand-a')
})
afterAll(async () => {
  await db?.drop()
})

const code = async (run: () => Promise<unknown>): Promise<string | null> =>
  run().then(
    () => null,
    (e: { code?: string }) => e.code ?? 'no_code',
  )

// Runs `fn` as mkt_app with the brand set, in a transaction that is rolled back.
async function asApp<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: db.urlFor('app') })
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

async function userId(c: pg.Client): Promise<string> {
  const r = await c.query('select id from auth."user" limit 1')
  return r.rows[0].id as string
}

async function seedJob(target: TestDatabase, brand: string): Promise<{ runId: string; jobId: string }> {
  const def = await seedDefinition(target)
  const runId = await seedRun(target, brand, def)
  const jobId = (await target.admin.query<{ id: string }>('select gen_random_uuid() as id')).rows[0]!.id
  await target.admin.query(
    `insert into app.job_input (job_id, brand_id, run_id, class, input, expected_result_type)
     values ($1, $2, $3, 'production', '{}', 't')`,
    [jobId, brand, runId],
  )
  return { runId, jobId }
}

describe('migration 0028: owner statements and question state', () => {
  it('an owner statement needs stated_by', async () => {
    await asApp(async (c) => {
      const uid = await userId(c)
      await c.query('savepoint s1')
      expect(
        await code(() =>
          c.query(
            "insert into app.research_source (brand_id, kind, result, extract) values ($1, 'owner_statement', 'stated', 'x')",
            [A],
          ),
        ),
      ).toBe('23514')
      await c.query('rollback to savepoint s1')
      await c.query(
        "insert into app.research_source (brand_id, kind, result, extract, stated_by) values ($1, 'owner_statement', 'stated', 'x', $2)",
        [A, uid],
      )
      // Other kinds carry no user.
      await c.query(
        "insert into app.research_source (brand_id, kind, result, extract) values ($1, 'site', 'read', 'x')",
        [A],
      )
    })
  })

  it('a job can have only one open question', async () => {
    const { runId, jobId } = await seedJob(db, A)
    await asApp(async (c) => {
      const uid = await userId(c)
      const ask = () =>
        c.query(
          `insert into app.agent_question (brand_id, run_id, job_id, question, why) values ($1, $2, $3, 'q', 'w') returning id`,
          [A, runId, jobId],
        )
      const first = await ask()
      await c.query('savepoint s1')
      expect(await code(ask)).toBe('23505')
      await c.query('rollback to savepoint s1')
      await c.query(
        'update app.agent_question set answer = $2, answered_by = $3, answered_at = now() where id = $1',
        [first.rows[0].id, 'a', uid],
      )
      await ask()
    })
  })

  it('question positions are unique within a questionnaire', async () => {
    await asApp(async (c) => {
      const q = await c.query('insert into app.questionnaire (brand_id) values ($1) returning id', [A])
      const add = (position: number, options: string | null = null) =>
        c.query(
          `insert into app.question (brand_id, questionnaire_id, key, position, text, why, options)
           values ($1, $2, $3, $4, 't', 'w', $5::jsonb)`,
          [A, q.rows[0].id, `k${position}-${Math.random()}`, position, options],
        )
      await add(1)
      await c.query('savepoint s1')
      expect(await code(() => add(1))).toBe('23505')
      await c.query('rollback to savepoint s1')
      expect(await code(() => add(0))).toBe('23514')
      await c.query('rollback to savepoint s1')
      expect(await code(() => add(2, '{"a":1}'))).toBe('23514')
      await c.query('rollback to savepoint s1')
      expect(await code(() => add(2, '["a", 2]'))).toBe('23514')
      await c.query('rollback to savepoint s1')
      await add(2, '["a","b"]')
    })
  })

  it('taking 0028 off keeps every answer and question', async () => {
    const own = await createTestDatabase()
    try {
      const url = own.urlFor('migration')
      await seedBrand(own, A, 'brand-a')
      const { runId, jobId } = await seedJob(own, A)
      const uid = (await own.admin.query('select id from auth."user" limit 1')).rows[0].id as string
      const source = (
        await own.admin.query(
          `insert into app.research_source (brand_id, kind, result, extract, stated_by)
           values ($1, 'owner_statement', 'stated', 'x', $2) returning id`,
          [A, uid],
        )
      ).rows[0].id as string
      const qn = (
        await own.admin.query('insert into app.questionnaire (brand_id) values ($1) returning id', [A])
      ).rows[0].id as string
      const question = (
        await own.admin.query(
          `insert into app.question (brand_id, questionnaire_id, key, position, text, why)
           values ($1, $2, 'k', 1, 't', 'w') returning id`,
          [A, qn],
        )
      ).rows[0].id as string
      await own.admin.query(
        `insert into app.answer (brand_id, question_id, value, answered_by, source_id) values ($1, $2, 'v', $3, $4)`,
        [A, question, uid, source],
      )
      await own.admin.query(
        `insert into app.agent_question (brand_id, run_id, job_id, question, why, suggested) values ($1, $2, $3, 'q', 'w', 's')`,
        [A, runId, jobId],
      )
      await runner({
        databaseUrl: url,
        dir: new URL('../migrations', import.meta.url).pathname,
        migrationsTable: 'pgmigrations',
        migrationsSchema: 'public',
        createSchema: false,
        log: () => undefined,
        direction: 'down',
        count: 1,
      })
      const count = async (t: string) =>
        (await own.admin.query(`select count(*)::int as n from app.${t}`)).rows[0].n as number
      expect(await count('question')).toBe(1)
      expect(await count('answer')).toBe(1)
      expect(await count('agent_question')).toBe(1)
      // seedBrand adds one source of its own, so two sources remain.
      expect(await count('research_source')).toBe(2)
      const cols = await own.admin.query(
        `select column_name from information_schema.columns
          where table_schema = 'app'
            and ((table_name = 'research_source' and column_name = 'stated_by')
              or (table_name = 'questionnaire' and column_name in ('finished_at','finished_by'))
              or (table_name = 'answer' and column_name = 'source_id')
              or (table_name = 'agent_question' and column_name in ('suggested','reminded_at','source_id')))`,
      )
      expect(cols.rows).toEqual([])
    } finally {
      await own.drop()
    }
  })
})
