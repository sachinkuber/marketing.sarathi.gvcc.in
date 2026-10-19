import pg from 'pg'
import { runner } from 'node-pg-migrate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase } from '@mkt/test-support'
import { migrate } from '../src/migrate.ts'
import { withBrand } from '../src/index.ts'
import { createTestDatabase, seedBrand, seedDefinition, type TestDatabase } from '../src/testing.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

const STATES = [
  'draft',
  'in_checks',
  'check_failed',
  'awaiting_approval',
  'approved',
  'rejected',
  'superseded',
  'invalidated',
  'scheduled',
  'publish_unknown',
  'published',
  'withdrawn',
]
// An independent copy of the list, so a change to the migration has to be made here too.
const ALLOWED: Array<[string, string]> = [
  ['draft', 'in_checks'],
  ['draft', 'superseded'],
  ['in_checks', 'check_failed'],
  ['in_checks', 'awaiting_approval'],
  ['in_checks', 'superseded'],
  ['check_failed', 'superseded'],
  ['awaiting_approval', 'approved'],
  ['awaiting_approval', 'rejected'],
  ['awaiting_approval', 'superseded'],
  ['approved', 'scheduled'],
  ['approved', 'superseded'],
  ['approved', 'invalidated'],
  ['scheduled', 'invalidated'],
  ['scheduled', 'published'],
  ['scheduled', 'publish_unknown'],
  ['publish_unknown', 'published'],
  ['publish_unknown', 'scheduled'],
  ['published', 'withdrawn'],
]

let db: TestDatabase
let app: pg.Pool
let ownerView: pg.Pool
let userA: string
let versionA: { id: string; hash: string; scheme: string }

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
  userA = (
    await db.admin.query<{ user_id: string }>('select user_id from app.membership where brand_id = $1', [A])
  ).rows[0]!.user_id
  versionA = { id: v.rows[0]!.id, hash: v.rows[0]!.hash, scheme: v.rows[0]!.hash_scheme }
})
afterAll(async () => {
  await app?.end()
  await ownerView?.end()
  await db?.drop()
})

// Runs fn in a transaction as the table owner with the brand set, and always rolls back.
async function inRolledBackTx<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: db.urlFor('migration') })
  await c.connect()
  try {
    await c.query('begin')
    await c.query("select set_config('app.brand_id', $1, true)", [A])
    return await fn(c)
  } finally {
    await c.query('rollback').catch(() => undefined)
    await c.end()
  }
}

const insertApproval = (hash: string, scheme: string) => (c: pg.PoolClient) =>
  c.query(
    `insert into app.approval (brand_id, content_version_id, version_hash, hash_scheme, decision, decided_by)
     values ($1, $2, $3, $4, 'approved', $5)`,
    [A, versionA.id, hash, scheme, userA],
  )

describe('approval hash guard', () => {
  it('refuses an approval with the wrong hash', async () => {
    await expect(
      withBrand(app, A, insertApproval('sha256:' + '0'.repeat(64), versionA.scheme)),
    ).rejects.toThrow(/different hash than its version/)
  })
  it('refuses an approval with the wrong hash scheme', async () => {
    await expect(withBrand(app, A, insertApproval(versionA.hash, 'cv2'))).rejects.toThrow(/hash scheme/)
  })
  it('accepts the right pair', async () => {
    await withBrand(app, A, insertApproval(versionA.hash, versionA.scheme))
    const r = await withBrand(app, A, (c) => c.query('select 1 from app.approval'))
    expect(r.rowCount).toBe(1)
  })
})

describe('version state transitions', () => {
  it('exposes the allowed pairs as a table equal to the expected list', async () => {
    const r = await db.admin.query<{ from_state: string; to_state: string }>(
      'select from_state, to_state from app.version_state_transition',
    )
    const got = r.rows.map((x) => `${x.from_state}>${x.to_state}`).sort()
    expect(got).toEqual(ALLOWED.map(([f, t]) => `${f}>${t}`).sort())
  })

  it('accepts every allowed transition and refuses every other pair (12 x 12)', async () => {
    const allowed = new Set(ALLOWED.map(([f, t]) => `${f}>${t}`))
    expect(STATES).toHaveLength(12)
    let accepted = 0
    let refused = 0
    for (const from of STATES) {
      for (const to of STATES) {
        await inRolledBackTx(async (c) => {
          await c.query(
            "insert into app.content_version_state (content_version_id, brand_id, state) values ($1, $2, 'draft')",
            [versionA.id, A],
          )
          // Put the row in the starting state without the guard, then test the guard on the move.
          await c.query('alter table app.content_version_state disable trigger version_state_transition')
          await c.query('update app.content_version_state set state = $1 where content_version_id = $2', [
            from,
            versionA.id,
          ])
          await c.query('alter table app.content_version_state enable trigger version_state_transition')
          await c.query('savepoint move')
          const move = c.query(
            'update app.content_version_state set state = $1 where content_version_id = $2',
            [to, versionA.id],
          )
          if (from === to || allowed.has(`${from}>${to}`)) {
            await move
            accepted++
          } else {
            await expect(move, `${from} -> ${to}`).rejects.toThrow(/cannot move/)
            refused++
          }
        })
      }
    }
    // Same-state touches (12) are accepted as no-ops.
    expect(accepted).toBe(ALLOWED.length + 12)
    expect(refused).toBe(144 - 12 - ALLOWED.length)
  })

  it('refuses a version that starts in any state but draft', async () => {
    await inRolledBackTx(async (c) => {
      await expect(
        c.query(
          "insert into app.content_version_state (content_version_id, brand_id, state) values ($1, $2, 'approved')",
          [versionA.id, A],
        ),
      ).rejects.toThrow(/starts as draft/)
    })
  })
})

describe('approval requests and outbox actions', () => {
  it('refuses a second request for one version, open or closed', async () => {
    await inRolledBackTx(async (c) => {
      const ins = 'insert into app.approval_request (brand_id, content_version_id) values ($1, $2)'
      await c.query(ins, [A, versionA.id])
      await c.query('savepoint s')
      await expect(c.query(ins, [A, versionA.id])).rejects.toThrow(/approval_request_content_version_id_key/)
      await c.query('rollback to savepoint s')
      await c.query('update app.approval_request set closed_at = now() where content_version_id = $1', [
        versionA.id,
      ])
      await expect(c.query(ins, [A, versionA.id])).rejects.toThrow(/approval_request_content_version_id_key/)
    })
  })

  it('refuses an outbox action whose kind is not none', async () => {
    const ins = (kind: string) => (c: pg.PoolClient) =>
      c.query(
        'insert into app.outbox_action (brand_id, kind, idempotency_key) values ($1, $2, gen_random_uuid())',
        [A, kind],
      )
    await expect(withBrand(app, A, ins('x'))).rejects.toThrow(/outbox_action_kind_check/)
    await withBrand(app, A, ins('none'))
  })
})

describe('notification and alert tables', () => {
  it('shows a notification only to its own brand', async () => {
    await withBrand(app, A, (c) =>
      c.query(
        "insert into app.notification (brand_id, user_id, kind, channel) values ($1, gen_random_uuid(), 'approval_waiting', 'email')",
        [A],
      ),
    )
    const own = await withBrand(app, A, (c) => c.query('select state, attempts from app.notification'))
    const other = await withBrand(app, B, (c) => c.query('select 1 from app.notification'))
    expect(own.rows).toEqual([{ state: 'queued', attempts: 0 }])
    expect(other.rowCount).toBe(0)
    await expect(
      withBrand(app, B, (c) =>
        c.query(
          "insert into app.notification (brand_id, user_id, kind, channel) values ($1, gen_random_uuid(), 'x', 'email')",
          [A],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('shows a brand alert only to its own brand', async () => {
    await withBrand(app, A, (c) =>
      c.query("insert into app.alert (brand_id, severity, kind) values ($1, 2, 'overdue')", [A]),
    )
    expect((await withBrand(app, A, (c) => c.query('select 1 from app.alert'))).rowCount).toBe(1)
    expect((await withBrand(app, B, (c) => c.query('select 1 from app.alert'))).rowCount).toBe(0)
    await expect(
      withBrand(app, A, (c) =>
        c.query("insert into app.alert (brand_id, severity, kind) values ($1, 4, 'x')", [A]),
      ),
    ).rejects.toThrow(/check/)
  })

  it('hides a platform alert from every brand session and shows it through platform_alerts() to the owner only', async () => {
    await db.admin.query(
      "insert into app.alert (brand_id, severity, kind, detail) values (null, 3, 'platform_test', '{\"n\":1}')",
    )
    for (const brand of [A, B]) {
      const r = await withBrand(app, brand, (c) =>
        c.query("select 1 from app.alert where kind = 'platform_test'"),
      )
      expect(r.rowCount).toBe(0)
    }
    // A brand session cannot write one either, nor turn its own alert into one.
    await expect(
      withBrand(app, A, (c) =>
        c.query("insert into app.alert (brand_id, severity, kind) values (null, 1, 'x')"),
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(
      withBrand(app, A, (c) => c.query('update app.alert set brand_id = null where brand_id = $1', [A])),
    ).rejects.toThrow(/row-level security/)

    const seen = await ownerView.query<{ kind: string; brand_id: string | null }>(
      'select kind, brand_id from app.platform_alerts()',
    )
    expect(seen.rows).toEqual([{ kind: 'platform_test', brand_id: null }])
    await expect(app.query('select * from app.platform_alerts()')).rejects.toThrow(/permission denied/)
    await expect(ownerView.query('select * from app.alert')).rejects.toThrow(/permission denied/)
  })
})

describe('hold_brand_jobs', () => {
  async function job(brand: string, agent: string, finished = false): Promise<string> {
    const def = await seedDefinition(db, agent)
    const run = await db.admin.query<{ id: string }>(
      `insert into app.run (brand_id, agent, definition_version_id, state, started_by_kind)
       values ($1, $2, $3, 'running', 'system') returning id`,
      [brand, agent, def],
    )
    const id = (await db.admin.query<{ id: string }>('select gen_random_uuid() as id')).rows[0]!.id
    await db.admin.query(
      `insert into app.job_input (job_id, brand_id, run_id, class, input, expected_result_type, finished_at)
       values ($1, $2, $3, 'production', '{}', 't', $4)`,
      [id, brand, run.rows[0]!.id, finished ? new Date() : null],
    )
    await db.admin.query('insert into app.job_control (job_id, brand_id) values ($1, $2)', [id, brand])
    return id
  }
  const hold = (brand: string, agent: string | null, on: boolean) =>
    withBrand(app, brand, (c) =>
      c.query<{ hold_brand_jobs: string }>('select * from app.hold_brand_jobs($1, $2, $3)', [
        brand,
        agent,
        on,
      ]),
    ).then((r) => r.rows.map((x) => x.hold_brand_jobs).sort())
  const held = async (id: string) =>
    (await db.admin.query('select held from app.job_control where job_id = $1', [id])).rows[0].held

  it('holds the unfinished jobs of one brand, optionally of one agent, and releases them, returning the ids changed', async () => {
    const a1 = await job(A, 'writer')
    const a2 = await job(A, 'designer')
    const aDone = await job(A, 'writer', true)
    const b1 = await job(B, 'writer')

    expect(await hold(A, 'writer', true)).toEqual([a1])
    expect(await held(a1)).toBe(true)
    expect(await held(a2)).toBe(false)
    // Holding again changes nothing.
    expect(await hold(A, 'writer', true)).toEqual([])

    expect(await hold(A, null, true)).toEqual([a2])
    expect(await held(aDone)).toBe(false)
    expect(await held(b1)).toBe(false)

    expect(await hold(A, 'designer', false)).toEqual([a2])
    expect(await held(a2)).toBe(false)
    expect(await held(a1)).toBe(true)
    expect(await hold(A, null, false)).toEqual([a1])
    expect(await held(a1)).toBe(false)
  })

  it("refuses a session that names another brand and leaves that brand's jobs alone", async () => {
    const b = await job(B, 'writer')
    expect(await held(b)).toBe(false)
    await expect(
      withBrand(app, A, (c) => c.query('select * from app.hold_brand_jobs($1, null, true)', [B])),
    ).rejects.toThrow(/only its own brand/)
    expect(await held(b)).toBe(false)
    // With no brand set at all, nothing is held either.
    await expect(app.query('select * from app.hold_brand_jobs($1, null, true)', [B])).rejects.toThrow(
      /only its own brand/,
    )
  })

  it('is executable by the application role only', async () => {
    await expect(ownerView.query('select * from app.hold_brand_jobs($1, null, true)', [A])).rejects.toThrow(
      /permission denied/,
    )
  })
})

describe('job_control.queue_id', () => {
  it('is a nullable uuid', async () => {
    const r = await db.admin.query(
      "select data_type, is_nullable from information_schema.columns where table_schema = 'app' and table_name = 'job_control' and column_name = 'queue_id'",
    )
    expect(r.rows).toEqual([{ data_type: 'uuid', is_nullable: 'YES' }])
  })
})

describe('migration 0015 alert delivery', () => {
  it('lets the app role use the delivery functions and nobody else', async () => {
    const id = await app.query<{ id: string | null }>(
      'select app.raise_alert(null, 2::smallint, \'x\', \'{"ref":"r"}\') as id',
    )
    expect(id.rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
    const again = await app.query<{ id: string | null }>(
      'select app.raise_alert(null, 2::smallint, \'x\', \'{"ref":"r"}\') as id',
    )
    expect(again.rows[0]?.id).toBeNull()
    expect((await app.query('select * from app.undelivered_alerts(10, now())')).rowCount).toBeGreaterThan(0)
    await expect(app.query("select app.raise_alert($1, 1::smallint, 'x', '{}')", [A])).rejects.toThrow(
      /own brand/,
    )
    await expect(ownerView.query('select * from app.undelivered_alerts(1, now())')).rejects.toThrow(
      /permission denied/,
    )
    await expect(ownerView.query('select app.platform_owner_ids()')).rejects.toThrow(/permission denied/)
    await db.admin.query("delete from app.alert where kind = 'x'")
  })
})

describe('migration 0014 down and up', () => {
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
      // 0017, 0016 and 0015 sit on top of 0014: all four come off.
      await runner({ ...base, direction: 'down', count: 4 })
      const gone = await own.admin.query(
        "select to_regclass('app.notification') as n, to_regclass('app.alert') as a, to_regclass('app.version_state_transition') as t, to_regprocedure('app.hold_brand_jobs(uuid,text,boolean)') as h",
      )
      expect(gone.rows[0]).toEqual({ n: null, a: null, t: null, h: null })
      await migrate(url)
      const back = await own.admin.query(
        "select to_regclass('app.notification') as n, to_regclass('app.alert') as a",
      )
      expect(back.rows[0].n).toBe('app.notification')
      expect(back.rows[0].a).toBe('app.alert')
    } finally {
      await own.drop()
    }
  })

  it('rolling back 0015 and the two after it leaves platform_alerts() working (0014 granted its select)', async () => {
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
      await runner({ ...base, direction: 'down', count: 3 })
      const gone = await own.admin.query(
        "select to_regprocedure('app.raise_alert(uuid,smallint,text,jsonb)') as r",
      )
      expect(gone.rows[0].r).toBeNull()
      // The function runs as mkt_definer: a revoked select would fail here with "permission denied".
      await expect(own.admin.query('select * from app.platform_alerts()')).resolves.toBeDefined()
    } finally {
      await own.drop()
    }
  })
})
