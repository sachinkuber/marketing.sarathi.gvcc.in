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

// An owner statement, as the answer route writes one for an answer.
async function ownerStatement(c: pg.Client, uid: string): Promise<string> {
  const r = await c.query(
    "insert into app.research_source (brand_id, kind, result, extract, stated_by) values ($1, 'owner_statement', 'stated', 'a', $2) returning id",
    [A, uid],
  )
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
        'update app.agent_question set answer = $2, answered_by = $3, answered_at = now(), source_id = $4 where id = $1',
        [first.rows[0].id, 'a', uid, await ownerStatement(c, uid)],
      )
      await ask()
    })
  })

  it('an answered question carries the owner statement of its answer, and an open one carries none (ruling R11)', async () => {
    const { runId, jobId } = await seedJob(db, A)
    await asApp(async (c) => {
      const uid = await userId(c)
      const source = await ownerStatement(c, uid)
      const id = (
        await c.query(
          `insert into app.agent_question (brand_id, run_id, job_id, question, why) values ($1, $2, $3, 'q', 'w') returning id`,
          [A, runId, jobId],
        )
      ).rows[0].id as string
      const set = (answer: string | null, sourceId: string | null) =>
        c.query(
          'update app.agent_question set answer = $2, answered_by = $3, answered_at = now(), source_id = $4 where id = $1',
          [id, answer, answer === null ? null : uid, sourceId],
        )
      await c.query('savepoint s1')
      // An answer with no statement, and a statement with no answer, are both refused.
      expect(await code(() => set('a', null))).toBe('23514')
      await c.query('rollback to savepoint s1')
      expect(await code(() => set(null, source))).toBe('23514')
      await c.query('rollback to savepoint s1')
      // An open question with a statement is refused when it is made, too.
      expect(
        await code(() =>
          c.query(
            `insert into app.agent_question (brand_id, run_id, job_id, question, why, source_id) values ($1, $2, $3, 'q', 'w', $4)`,
            [A, runId, jobId, source],
          ),
        ),
      ).toBe('23514')
      await c.query('rollback to savepoint s1')
      await set('a', source)
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

  it('one active fact per brand and statement hash (ruling R20)', async () => {
    await asApp(async (c) => {
      const uid = await userId(c)
      const source = await ownerStatement(c, uid)
      const fact = (hash: string, status = 'active') =>
        c.query(
          `insert into app.verified_fact (brand_id, statement, fact_hash, source_ids, confirmed_by, review_date, status)
           values ($1, 's', $2, $3::uuid[], $4, current_date + 30, $5) returning id`,
          [A, hash, [source], uid, status],
        )
      const first = (await fact('h-one')).rows[0].id as string
      await c.query('savepoint s1')
      expect(await code(() => fact('h-one'))).toBe('23505')
      await c.query('rollback to savepoint s1')
      // A fact out of force does not count: the same statement may be in force again once the old one is not.
      await fact('h-one', 'superseded')
      await fact('h-one', 'expired')
      await c.query(`update app.verified_fact set status = 'expired' where id = $1`, [first])
      await fact('h-one')
      await fact('h-two')
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
      const count = async (t: string) =>
        (await own.admin.query(`select count(*)::int as n from app.${t}`)).rows[0].n as number
      const tables = ['question', 'answer', 'agent_question', 'research_source']
      const before = await Promise.all(tables.map(count))
      await runner({
        databaseUrl: url,
        dir: new URL('../migrations', import.meta.url).pathname,
        migrationsTable: 'pgmigrations',
        migrationsSchema: 'public',
        createSchema: false,
        log: () => undefined,
        direction: 'down',
        // 0029 (the reminder sweep's brand list) comes off first.
        count: 2,
      })
      expect(await Promise.all(tables.map(count))).toEqual(before)
      const cols = await own.admin.query(
        `select column_name from information_schema.columns
          where table_schema = 'app'
            and ((table_name = 'research_source' and column_name = 'stated_by')
              or (table_name = 'questionnaire' and column_name in ('finished_at','finished_by'))
              or (table_name = 'answer' and column_name = 'source_id')
              or (table_name = 'agent_question' and column_name in ('suggested','reminded_at','source_id')))`,
      )
      expect(cols.rows).toEqual([])
      expect(
        (await own.admin.query(`select 1 from pg_indexes where indexname = 'verified_fact_one_active'`)).rows,
      ).toEqual([])
    } finally {
      await own.drop()
    }
  })

  // Takes 0029 and 0028 off a database with the seeded brand, so the next `migrate` applies 0028 to existing rows.
  async function at0027(): Promise<{ own: TestDatabase; url: string; uid: string }> {
    const own = await createTestDatabase()
    await seedBrand(own, A, 'brand-a')
    const url = own.urlFor('migration')
    await runner({
      databaseUrl: url,
      dir: new URL('../migrations', import.meta.url).pathname,
      migrationsTable: 'pgmigrations',
      migrationsSchema: 'public',
      createSchema: false,
      log: () => undefined,
      direction: 'down',
      count: 2,
    })
    const uid = (await own.admin.query('select id from auth."user" limit 1')).rows[0].id as string
    return { own, url, uid }
  }

  const statement = async (own: TestDatabase) =>
    (
      await own.admin.query(
        `insert into app.research_source (brand_id, kind, result, extract) values ($1, 'owner_statement', 'stated', 'x') returning id`,
        [A],
      )
    ).rows[0].id as string

  // A suggestion decided by `uid` and a fact from it that cites the statement.
  async function cited(own: TestDatabase, uid: string): Promise<string> {
    const id = await statement(own)
    const sug = (
      await own.admin.query(
        `insert into app.suggestion (brand_id, step, key, proposed, why, confidence, decision, decided_by, decided_at)
         values ($1, 'fact', 'k', '"x"'::jsonb, 'w', 'found', 'edited', $2, now()) returning id`,
        [A, uid],
      )
    ).rows[0].id as string
    await own.admin.query(
      `insert into app.verified_fact (brand_id, statement, fact_hash, source_ids, confirmed_by, review_date, from_suggestion)
       values ($1, 's', 'h', $2::uuid[], $3, current_date + 30, $4)`,
      [A, [id], uid, sug],
    )
    return id
  }

  const validated = async (own: TestDatabase) =>
    (
      await own.admin.query(
        `select convalidated from pg_constraint where conname = 'research_source_owner_statement_stated_by'`,
      )
    ).rows[0].convalidated as boolean

  it('the backfill gives a cited owner statement its deciding user; unmatched rows leave the check not valid', async () => {
    const { own, url, uid } = await at0027()
    try {
      const matched = await cited(own, uid)
      const unmatched = await statement(own)
      const { migrate } = await import('../src/migrate.ts')
      await migrate(url)
      const rows = await own.admin.query(
        'select id, stated_by from app.research_source where id = any($1::uuid[])',
        [[matched, unmatched]],
      )
      const by = Object.fromEntries(rows.rows.map((r) => [r.id, r.stated_by]))
      expect(by[matched]).toBe(uid)
      expect(by[unmatched]).toBeNull()
      expect(await validated(own)).toBe(false)
      expect(
        await code(() =>
          own.admin.query(
            "insert into app.research_source (brand_id, kind, result, extract) values ($1, 'owner_statement', 'stated', 'y')",
            [A],
          ),
        ),
      ).toBe('23514')
    } finally {
      await own.drop()
    }
  })

  it('with only matched owner statements the check is validated', async () => {
    const { own, url, uid } = await at0027()
    try {
      // The seeded brand's own statement is cited by no suggestion: make it an ordinary source here.
      await own.admin.query("update app.research_source set kind = 'site' where kind = 'owner_statement'")
      const matched = await cited(own, uid)
      const { migrate } = await import('../src/migrate.ts')
      await migrate(url)
      expect(
        (await own.admin.query('select stated_by from app.research_source where id = $1', [matched])).rows[0]
          .stated_by,
      ).toBe(uid)
      expect(await validated(own)).toBe(true)
    } finally {
      await own.drop()
    }
  })

  it('names two active facts with the same statement before it makes the one-active index', async () => {
    const { own, url, uid } = await at0027()
    try {
      const { migrate } = await import('../src/migrate.ts')
      for (let i = 0; i < 2; i++)
        await own.admin.query(
          `insert into app.verified_fact (brand_id, statement, fact_hash, source_ids, confirmed_by, review_date)
           values ($1, 'same', 'dup', '{}', $2, current_date + 30)`,
          [A, uid],
        )
      await expect(migrate(url)).rejects.toThrow(
        /0028: app\.verified_fact has more than one active fact with the same statement in a brand/,
      )
      await own.admin.query(
        `update app.verified_fact set status = 'expired' where ctid = (select ctid from app.verified_fact where fact_hash = 'dup' limit 1)`,
      )
      await migrate(url)
      expect(
        (await own.admin.query(`select 1 from pg_indexes where indexname = 'verified_fact_one_active'`)).rows,
      ).toHaveLength(1)
    } finally {
      await own.drop()
    }
  })

  it('names the offending rows before its checks run', async () => {
    const { own, url, uid } = await at0027()
    try {
      const { migrate } = await import('../src/migrate.ts')
      const { runId, jobId } = await seedJob(own, A)
      for (let i = 0; i < 2; i++)
        await own.admin.query(
          `insert into app.agent_question (brand_id, run_id, job_id, question, why) values ($1, $2, $3, 'q', 'w')`,
          [A, runId, jobId],
        )
      await expect(migrate(url)).rejects.toThrow(
        /0028: app\.agent_question has a job with more than one unanswered question/,
      )
      // An answer from before 0028 has no owner statement to record it, so it is named too (ruling R11).
      await own.admin.query(
        'update app.agent_question set answer = $1, answered_by = $2, answered_at = now() where ctid = (select ctid from app.agent_question limit 1)',
        ['a', uid],
      )
      await expect(migrate(url)).rejects.toThrow(
        /0028: app\.agent_question has answered questions with no owner statement of the answer/,
      )
      await own.admin.query('delete from app.agent_question where answer is not null')
      const qn = (
        await own.admin.query('insert into app.questionnaire (brand_id) values ($1) returning id', [A])
      ).rows[0].id
      for (const k of ['a', 'b'])
        await own.admin.query(
          `insert into app.question (brand_id, questionnaire_id, key, position, text, why) values ($1, $2, $3, 1, 't', 'w')`,
          [A, qn, k],
        )
      await expect(migrate(url)).rejects.toThrow(/0028: app\.question repeats a position/)
      await own.admin.query("update app.question set position = 2 where key = 'b'")
      await own.admin.query(`update app.question set options = '[1]'::jsonb where key = 'b'`)
      await expect(migrate(url)).rejects.toThrow(
        /0028: app\.question has options that are not a list of strings/,
      )
    } finally {
      await own.drop()
    }
  })
})
