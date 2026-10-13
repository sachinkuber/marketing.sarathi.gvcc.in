import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase } from '@mkt/test-support'
import { withBrand } from '../src/index.ts'
import { createTestDatabase, seedBrand, seedDefinition, seedRun, type TestDatabase } from '../src/testing.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
let db: TestDatabase
let app: pg.Pool

beforeAll(async () => {
  await requireDatabase()
  db = await createTestDatabase()
  await seedBrand(db, A, 'brand-a')
  await seedBrand(db, B, 'brand-b')
  app = new pg.Pool({ connectionString: db.urlFor('app') })
})
afterAll(async () => {
  await app?.end()
  await db?.drop()
})

async function newJob(brand: string, jobId: string): Promise<{ runId: string }> {
  const def = await seedDefinition(db)
  const runId = await seedRun(db, brand, def)
  await withBrand(app, brand, (c) =>
    c.query(
      `insert into app.job_input (job_id, brand_id, run_id, class, input, expected_result_type)
       values ($1, $2, $3, 'production', '{}', 'test.echo')`,
      [jobId, brand, runId],
    ),
  )
  return { runId }
}

describe('work-engine tables', () => {
  it('shows a job only to its own brand', async () => {
    const jobId = '33333333-3333-4333-8333-333333333333'
    await newJob(A, jobId)
    const own = await withBrand(app, A, (c) => c.query('select job_id from app.job_input'))
    const other = await withBrand(app, B, (c) => c.query('select job_id from app.job_input'))
    expect(own.rowCount).toBe(1)
    expect(other.rowCount).toBe(0)
  })

  it('refuses a second active attempt for one job and a repeated attempt number', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444'
    await newJob(A, jobId)
    const insert = (n: number, state: string) =>
      withBrand(app, A, (c) =>
        c.query(
          `insert into app.job_attempt (brand_id, job_id, attempt_number, worker_id, token_id, state)
           values ($1, $2, $3, 'w1', gen_random_uuid(), $4)`,
          [A, jobId, n, state],
        ),
      )
    await insert(1, 'active')
    await expect(insert(2, 'active')).rejects.toThrow(/job_attempt_one_active/)
    await expect(insert(1, 'superseded')).rejects.toThrow(/duplicate key/)
  })

  it('refuses a model call whose attempt belongs to another brand', async () => {
    const jobA = '55555555-5555-4555-8555-555555555555'
    const { runId } = await newJob(A, jobA)
    const attempt = await withBrand(app, A, (c) =>
      c.query<{ id: string }>(
        `insert into app.job_attempt (brand_id, job_id, attempt_number, worker_id, token_id)
         values ($1, $2, 1, 'w1', gen_random_uuid()) returning id`,
        [A, jobA],
      ),
    )
    await expect(
      withBrand(app, B, (c) =>
        c.query(
          `insert into app.model_call (brand_id, run_id, job_id, attempt_id, step, request_hash, model)
           values ($1, $2, $3, $4, 's', 'h', 'm')`,
          [B, runId, jobA, attempt.rows[0]!.id],
        ),
      ),
    ).rejects.toThrow()
  })

  it('costs a model call once', async () => {
    const jobId = '66666666-6666-4666-8666-666666666666'
    const { runId } = await newJob(A, jobId)
    const fx = await db.admin.query<{ id: string }>(
      `select app.record_fx_rate(current_date, 83500000, 'test') as id`,
    )
    const attempt = await withBrand(app, A, (c) =>
      c.query<{ id: string }>(
        `insert into app.job_attempt (brand_id, job_id, attempt_number, worker_id, token_id)
         values ($1, $2, 1, 'w1', gen_random_uuid()) returning id`,
        [A, jobId],
      ),
    )
    const call = await withBrand(app, A, (c) =>
      c.query<{ id: string }>(
        `insert into app.model_call (brand_id, run_id, job_id, attempt_id, step, request_hash, model)
         values ($1, $2, $3, $4, 's', 'h', 'm') returning id`,
        [A, runId, jobId, attempt.rows[0]!.id],
      ),
    )
    const cost = (c: pg.PoolClient) =>
      c.query(
        `insert into app.cost_ledger (brand_id, run_id, agent, model_call_id, charged_micros, charged_currency, usd_micros, inr_micros, fx_rate_id)
         values ($1, $2, 'test', $3, 100, 'USD', 100, 8350, $4)`,
        [A, runId, call.rows[0]!.id, fx.rows[0]!.id],
      )
    await withBrand(app, A, cost)
    await expect(withBrand(app, A, cost)).rejects.toThrow(/duplicate key/)
  })

  it('keeps one live version per agent', async () => {
    await db.admin.query(
      `insert into app.agent_definition_version (agent, version, model, effort, files_hash, live)
       values ('live-test', 1, 'm', 'low', 'h', true)`,
    )
    await expect(
      db.admin.query(
        `insert into app.agent_definition_version (agent, version, model, effort, files_hash, live)
         values ('live-test', 2, 'm', 'low', 'h', true)`,
      ),
    ).rejects.toThrow(/agent_definition_one_live/)
  })

  it('resolves a job to its brand through a function the application role may call, and nothing else may', async () => {
    const jobId = '77777777-7777-4777-8777-777777777777'
    await newJob(A, jobId)
    const found = await app.query<{ brand: string }>('select app.job_brand($1) as brand', [jobId])
    expect(found.rows[0]!.brand).toBe(A)
    for (const role of ['queue', 'readonly', 'audit_writer'] as const) {
      const pool = new pg.Pool({ connectionString: db.urlFor(role) })
      await expect(pool.query('select app.job_brand($1)', [jobId])).rejects.toThrow(/permission denied/)
      await pool.end()
    }
  })

  it('marks old started calls unknown across brands, and leaves recent ones', async () => {
    const jobId = '88888888-8888-4888-8888-888888888888'
    const { runId } = await newJob(A, jobId)
    const attempt = await withBrand(app, A, (c) =>
      c.query<{ id: string }>(
        `insert into app.job_attempt (brand_id, job_id, attempt_number, worker_id, token_id)
         values ($1, $2, 1, 'w1', gen_random_uuid()) returning id`,
        [A, jobId],
      ),
    )
    await withBrand(app, A, (c) =>
      c.query(
        `insert into app.model_call (brand_id, run_id, job_id, attempt_id, step, request_hash, model, started_at)
         values ($1, $2, $3, $4, 'old', 'h1', 'm', now() - interval '3 hours'),
                ($1, $2, $3, $4, 'new', 'h2', 'm', now())`,
        [A, runId, jobId, attempt.rows[0]!.id],
      ),
    )
    const swept = await app.query<{ n: number }>(
      `select app.sweep_model_calls('production', now() - interval '1 hour') as n`,
    )
    expect(swept.rows[0]!.n).toBeGreaterThanOrEqual(1)
    const rows = await withBrand(app, A, (c) =>
      c.query<{ step: string; status: string }>(
        `select step, status from app.model_call where job_id = $1 order by step`,
        [jobId],
      ),
    )
    expect(rows.rows).toEqual([
      { step: 'new', status: 'started' },
      { step: 'old', status: 'unknown' },
    ])
  })
})
