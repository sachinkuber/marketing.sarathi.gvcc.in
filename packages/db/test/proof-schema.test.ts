import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { runner } from 'node-pg-migrate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase } from '@mkt/test-support'
import { migrate } from '../src/migrate.ts'
import { agentFilesHash, SUMMARY_AGENT_DIR } from './agent-files-hash.ts'
import { createTestDatabase, seedBrand, type TestDatabase } from '../src/testing.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

let db: TestDatabase
let app: pg.Pool
let ownerView: pg.Pool
let versionA: { id: string; hash: string; scheme: string }
let userA: string

beforeAll(async () => {
  await requireDatabase()
  db = await createTestDatabase()
  await seedBrand(db, A, 'brand-a')
  await seedBrand(db, B, 'brand-b')
  app = new pg.Pool({ connectionString: db.urlFor('app') })
  ownerView = new pg.Pool({ connectionString: db.urlFor('owner_view') })
  const v = await db.admin.query<{ id: string; hash: string; hash_scheme: string }>(
    'select id, hash, hash_scheme from app.content_version where brand_id = $1',
    [A],
  )
  versionA = { id: v.rows[0]!.id, hash: v.rows[0]!.hash, scheme: v.rows[0]!.hash_scheme }
  userA = (
    await db.admin.query<{ user_id: string }>('select user_id from app.membership where brand_id = $1', [A])
  ).rows[0]!.user_id
})
afterAll(async () => {
  await app?.end()
  await ownerView?.end()
  await db?.drop()
})

describe('trigger_nonce', () => {
  it('accepts a nonce once; a repeat returns no row', async () => {
    const sql = 'insert into app.trigger_nonce (nonce) values ($1) on conflict do nothing returning nonce'
    const nonce = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
    expect((await app.query(sql, [nonce])).rowCount).toBe(1)
    expect((await app.query(sql, [nonce])).rowCount).toBe(0)
  })

  it('lets the application role select and delete but not update', async () => {
    const nonce = Buffer.from('aa'.repeat(16), 'hex')
    await app.query('insert into app.trigger_nonce (nonce) values ($1)', [nonce])
    expect((await app.query('select 1 from app.trigger_nonce where nonce = $1', [nonce])).rowCount).toBe(1)
    await expect(
      app.query('update app.trigger_nonce set received_at = now() where nonce = $1', [nonce]),
    ).rejects.toThrow(/permission denied/)
    expect((await app.query('delete from app.trigger_nonce where nonce = $1', [nonce])).rowCount).toBe(1)
  })
})

describe('duty_run', () => {
  const ins = (duty: string, date: string, state: string) =>
    app.query('insert into app.duty_run (duty, run_date, state) values ($1, $2, $3)', [duty, date, state])

  it('refuses an unknown state', async () => {
    await expect(ins('daily_x', '2026-10-19', 'sleeping')).rejects.toThrow(/duty_run_state_check/)
  })

  it('refuses a second row for the same duty and date, and accepts each known state', async () => {
    await ins('daily_y', '2026-10-19', 'running')
    await expect(ins('daily_y', '2026-10-19', 'done')).rejects.toThrow(/duty_run_pkey/)
    for (const [i, state] of ['done', 'failed', 'not_configured'].entries()) {
      await ins('daily_y', `2026-10-2${i}`, state)
    }
  })

  it('lets the application role update a row', async () => {
    await ins('n8n_heartbeat', '2026-10-19', 'running')
    const r = await app.query(
      "update app.duty_run set state = 'done', finished_at = now(), detail = '{}' where duty = 'n8n_heartbeat'",
    )
    expect(r.rowCount).toBe(1)
  })
})

describe('summary agent definition', () => {
  it('has exactly one live summary definition: version 1, claude-opus-5-5, low', async () => {
    const r = await db.admin.query(
      "select version, model, effort, files_hash from app.agent_definition_version where agent = 'summary' and live",
    )
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ version: 1, model: 'claude-opus-5-5', effort: 'low' })
    const definition = JSON.parse(readFileSync(join(SUMMARY_AGENT_DIR, 'definition.json'), 'utf8'))
    expect(r.rows[0]).toMatchObject({
      version: definition.version,
      model: definition.model,
      effort: definition.effort,
    })
    expect(definition.agent).toBe('summary')
    expect(r.rows[0].files_hash).toBe(agentFilesHash(SUMMARY_AGENT_DIR))
  })
})

describe('audit.search', () => {
  const APPEND = 'select audit.append($1::uuid, $2::app.actor_kind, $3::uuid, $4, $5, $6, $7::jsonb) as seq'
  const actor = '33333333-3333-4333-8333-333333333333'
  const search = (
    chain: string,
    o: { actor?: string; action?: string; from?: string; to?: string; before?: number; limit?: number } = {},
  ) =>
    ownerView
      .query<{ seq: string; action: string }>('select seq, action from audit.search($1,$2,$3,$4,$5,$6,$7)', [
        chain,
        o.actor ?? null,
        o.action ?? null,
        o.from ?? null,
        o.to ?? null,
        o.before ?? null,
        o.limit ?? 50,
      ])
      .then((r) => r.rows.map((x) => [Number(x.seq), x.action] as const))

  beforeAll(async () => {
    for (let i = 1; i <= 5; i++) {
      await db.admin.query(APPEND, [
        A,
        i % 2 ? 'user' : 'system',
        i % 2 ? actor : null,
        i === 3 ? 'proof.other' : 'proof.thing',
        'success',
        null,
        null,
      ])
    }
    await db.admin.query(APPEND, [B, 'system', null, 'proof.thing', 'success', null, null])
  })

  it('returns one chain newest first', async () => {
    expect((await search(A)).map((x) => x[0])).toEqual([5, 4, 3, 2, 1])
    expect((await search(B)).map((x) => x[0])).toEqual([1])
  })

  it('honours each filter', async () => {
    expect((await search(A, { actor })).map((x) => x[0])).toEqual([5, 3, 1])
    expect((await search(A, { action: 'proof.other' })).map((x) => x[0])).toEqual([3])
    // Text keeps the microseconds a JavaScript Date would drop.
    const at = await db.admin.query<{ at: string }>(
      'select at::text as at from audit.log where chain_key = $1 and seq = 3',
      [A],
    )
    const t3 = at.rows[0]!.at
    expect((await search(A, { from: t3 })).map((x) => x[0])).toEqual([5, 4, 3])
    expect((await search(A, { to: t3 })).map((x) => x[0])).toEqual([3, 2, 1])
  })

  it('pages with before_seq and clamps the limit to 1..200', async () => {
    expect((await search(A, { before: 4 })).map((x) => x[0])).toEqual([3, 2, 1])
    expect(await search(A, { limit: 2 })).toHaveLength(2)
    expect(await search(A, { limit: 0 })).toHaveLength(1)
    expect(await search(A, { limit: -5 })).toHaveLength(1)
    const many = await db.admin.query(
      `select audit.append(null, 'system', null, 'proof.bulk', 'success', null, null) from generate_series(1, 230)`,
    )
    expect(many.rowCount).toBe(230)
    expect(await search('platform', { limit: 1000 })).toHaveLength(200)
  })

  it('is not executable by the application role', async () => {
    await expect(
      app.query("select * from audit.search('x', null, null, null, null, null, 5)"),
    ).rejects.toThrow(/permission denied/)
  })
})

describe('awaiting_approval to approved needs an approval row', () => {
  async function inTx<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: db.urlFor('migration') })
    await c.connect()
    try {
      await c.query('begin')
      await c.query("select set_config('app.brand_id', $1, true)", [A])
      await c.query(
        "insert into app.content_version_state (content_version_id, brand_id, state) values ($1, $2, 'draft')",
        [versionA.id, A],
      )
      await c.query(
        "update app.content_version_state set state = 'in_checks' where content_version_id = $1",
        [versionA.id],
      )
      await c.query(
        "update app.content_version_state set state = 'awaiting_approval' where content_version_id = $1",
        [versionA.id],
      )
      return await fn(c)
    } finally {
      await c.query('rollback').catch(() => undefined)
      await c.end()
    }
  }
  const approve = (c: pg.Client) =>
    c.query("update app.content_version_state set state = 'approved' where content_version_id = $1", [
      versionA.id,
    ])
  const decide = (c: pg.Client, decision: string) =>
    c.query(
      `insert into app.approval (brand_id, content_version_id, version_hash, hash_scheme, decision, decided_by)
       values ($1, $2, $3, $4, $5, $6)`,
      [A, versionA.id, versionA.hash, versionA.scheme, decision, userA],
    )

  it('refuses the move with no approval row', async () => {
    await inTx(async (c) => {
      await expect(approve(c)).rejects.toThrow(/approving decision/)
    })
  })

  it('refuses the move when the only decision is a rejection', async () => {
    await inTx(async (c) => {
      await decide(c, 'rejected')
      await expect(approve(c)).rejects.toThrow(/approving decision/)
    })
  })

  it('accepts the move once an approving decision exists', async () => {
    await inTx(async (c) => {
      await decide(c, 'approved')
      await approve(c)
    })
  })
})

describe('migration 0018 down and up', () => {
  it('can be undone and applied again', async () => {
    const own = await createTestDatabase()
    try {
      const url = own.urlFor('migration')
      const base = {
        databaseUrl: url,
        dir: new URL('../migrations', import.meta.url).pathname,
        migrationsTable: 'pgmigrations',
        migrationsSchema: 'public',
        createSchema: false,
        log: () => undefined,
      }
      // 0019 sits on top of 0018: both come off.
      await runner({ ...base, direction: 'down', count: 2 })
      const gone = await own.admin.query(
        "select to_regclass('app.trigger_nonce') as n, to_regclass('app.duty_run') as d, to_regprocedure('audit.search(text,uuid,text,timestamptz,timestamptz,bigint,integer)') as s, (select count(*) from app.agent_definition_version where agent = 'summary') as defs",
      )
      expect(gone.rows[0]).toEqual({ n: null, d: null, s: null, defs: '0' })
      await migrate(url)
      const back = await own.admin.query(
        "select to_regclass('app.trigger_nonce') as n, (select count(*) from app.agent_definition_version where agent = 'summary' and live) as defs",
      )
      expect(back.rows[0]).toEqual({ n: 'app.trigger_nonce', defs: '1' })
    } finally {
      await own.drop()
    }
  })
})
