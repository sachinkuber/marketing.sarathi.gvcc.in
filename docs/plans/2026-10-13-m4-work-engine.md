# Milestone 4 (Work engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A job is created with its cause, claimed, survives a crash, is applied once, and its model call and cost are recorded in both currencies (packages 7 and 8; acceptance tests 6, 24 to 29 and 32).

**Architecture:** A new `packages/queue` wraps pg-boss behind one interface (four job classes, per-process brand limits, heartbeats, dead letters). The core service owns every business write: it creates jobs inside the business transaction, starts attempts, issues and checks attempt tokens, records model calls and checkpoints, writes the cost ledger and applies results. A new `apps/worker` claims jobs from the queue and never touches the business database: it talks to the core over HTTP with a worker credential and, per job, an attempt token. The provider key lives only in the worker.

**Tech Stack:** pg-boss 12.30.0, PostgreSQL 17.11, Express 5.2.1, zod 4.5.4, `@anthropic-ai/sdk` 0.124.0 (worker only), Node 24.20.0, vitest. No new dependency except `@anthropic-ai/sdk` moving from `packages/stack-check` into `apps/worker` at the same pinned version.

**Spec:** `docs/specs/2026-10-04-phase-1-foundation.md` sections 9 (queue), 8 (API areas "Jobs" and "Job attempts"), 17 (tests 6, 24 to 29, 32), 18 (packages 7 and 8). Also `docs/architecture/2026-10-04-architecture.md` 7 and 13.3, `docs/database/2026-10-04-database-schema.md` 7, and `docs/trials/2026-10-04-queue-trial.md`.

## Scope

In this plan (packages 7 and 8):

- The queue interface over pg-boss: four classes with the settings of spec 9.3, one queue and one dead-letter queue per class, send inside a caller's transaction, per-process brand limits, heartbeats, depth and watchdog reads.
- The tables of database schema 7: `agent_definition_version`, `run`, `job_input`, `job_attempt`, `job_control`, `model_call`, `cost_ledger`, `fx_rate`, plus one new table, `model_price` (decision 5), and the grants on the `pgboss` schema.
- Job creation with its cause, in the same transaction as the business change, with backpressure.
- Attempts and the attempt token (spec 9.4); repeatable result posting; refusals recorded in the audit log.
- The model-call ledger (register before send, checkpoint, duplicate flag, reconciliation) and the cost ledger in US dollars and rupees (spec 9.5, database schema 7.6 to 7.8).
- The worker process: claim, start an attempt, run steps with checkpoints, cancel and held checks, post a result.
- Dead-letter list, requeue and cancel through the API; the model-call reconciliation sweep; the queue watchdog read.

Not in this plan, and why:

- **The kill switch itself** (cancelling a brand's waiting jobs and holding them, spec 9.2): package 12, milestone 5. The `job_control.held` flag, the held check in the worker and the post-time hold of a result are built here, and tests 30 and 31 are proven there.
- **Alerts for dead letters, long waits and unknown model calls:** package 11, milestone 5. The reads (`deadLetters`, `watchdog`, `unknownCalls`) exist now; nothing is wired to them.
- **The daily jobs** (exchange-rate fetch, reconciliation, the audit export and verify jobs from milestone 3): they need the signed trigger from n8n (package 14, milestone 6). This milestone ships the functions and a worker-side interval for reconciliation only (decision 8).
- **The trivial agent and its result type** (package 13) and **the dashboard screens for jobs, runs and cost** (package 15). A test result type stands in.
- **A real provider call in the test run:** needs owner item A3. The adapter is written and covered by the existing skipped model check; every other test uses a stand-in model.
- **Exchange-rate fetching from a provider:** a rate is entered through a function; fetching is milestone 6 (decision 6).

## Global Constraints

- Node 24.20.0, npm 11.19.0; every dependency an exact version; TypeScript run directly with `.ts` import extensions; `verbatimModuleSyntax`, `noUncheckedIndexedAccess`.
- Business data is reached only through `@mkt/db` (`withBrand`). `pg`, `kysely` and `pg-boss` are imported only in `packages/db`, `packages/queue`, `packages/test-support` and tests (the ESLint rule already allows `packages/queue/**`).
- The queue row holds a job ID, a class and a scheduling key and nothing else. The queue role cannot read any `app` table (acceptance test 5, spec 9.1).
- The queue's per-brand limit is the library's per-process limit, set to the brand's cap divided by the number of worker processes for that class; the library's global group limit is not used (trial section 3).
- Job class settings are exactly spec 9.3: interactive 60 s gap, 5 min expiry, 3 attempts; publishing 60 s, 10 min, 5; production 90 s, 30 min, 3; bulk 90 s, 2 h, 3. Caps per brand: 2, 2, 3, 1. Notification dispatch for interactive and publishing with a 2-second polling backstop; production and bulk poll every 2 seconds.
- A stored cost amount is never recalculated. Costs are bigint millionths; both US dollars and rupees are always filled; the rate row used is recorded.
- Every new brand table has row-level security enabled and forced, a `brand_isolation` policy exactly as the catalog test expects, `unique (brand_id, id)` where there is an `id`, and foreign keys between brand tables that carry `brand_id` on both sides.
- No server address, key or password in the repository. The worker credential, the attempt-token secret and the provider key come from the environment.
- Commands run on the development server (`/opt/mkt-dev/run.sh`), not on the laptop.

## Decisions proposed to the owner

These are choices the spec leaves open or that need a small departure from its wording. They are proposed here and are to be accepted, or changed, before the milestone is built. Each is written as the rule the build will follow.

1. **The core service reads the queue's state through the queue role, and creates jobs as the application role.** The spec says the worker "calls the core to start an attempt" and the core "confirms from the queue's own records that the job is active". The core therefore holds a second connection, logged in as the queue role, used only to read job state and to cancel, requeue and list dead jobs. Creating a job needs the caller's own transaction, so the application role is granted `insert` on `pgboss.job` and nothing else in that schema (the rights table in database schema 11.1 already says "Create jobs only"). Proposed: accept.
2. **Workers never reach the business database.** A worker holds the queue role's login (to claim) and a shared worker credential (to call the core). It has no `app` access. Every business effect goes through the core, which is also where the attempt token is checked. Proposed: accept.
3. **The attempt token is a signed string, not a library token.** `v1.<base64url JSON>.<base64url HMAC-SHA256>`, signed with its own secret (`ATTEMPT_TOKEN_SECRET`, different from the worker credential). Fields: token ID, job ID, brand ID, attempt ID, expected result type, issued-at and expiry. Expiry is the class's expiry. A token is valid only while its attempt is the job's current active attempt. Proposed: accept.
4. **Some columns are added to tables the spec lists.** `job_input.expected_result_type` (the token needs it), `job_input.result_type` and `job_input.outcome` (so a repeated post can return the first outcome), `job_input.finished_at`, `job_input.held_result` (a result posted while the job is held, stored and not applied), and `job_control.dead_at` (so the dead-letter list is a business query and needs no cross-brand read of the queue). The database schema document is updated. Proposed: accept.
5. **Model prices are data, in a new table `app.model_price`.** The provider's reply gives token counts, not a charge, so a price is needed when a call is costed. A row holds model, the four prices (input, output, cache read, cache write) in US-dollar millionths per million tokens, a start date and a source note; the newest row whose start date is not after the call is used. The build seeds no price: the owner confirms the figures from the provider's own price page and they are entered at deployment. (Third-party summaries put Claude Opus 5.5 at $4 input and $20 output per million tokens; they are not the provider's page and are not used as a source.) A call whose model has no price is recorded as succeeded with no cost row and appears in the reconciliation list; it never blocks the checkpoint. Proposed: accept.
6. **Exchange rates are entered, not fetched, in this milestone.** `app.record_fx_rate(date, rate_micros, source)` is a definer function the platform owner's tooling will call; fetching a daily rate needs the scheduled trigger of milestone 6 and a choice of source (an owner item). A cost uses the rate for its day, or the most recent earlier one, and records which (spec: "the most recent one is used and the row records which"). With no rate at all the checkpoint is refused for the cost only in the sense of decision 5: no cost row, listed for reconciliation. Rupees are rounded half up from the dollar amount: `inr = round(usd * rate / 1_000_000)`. Proposed: accept.
7. **Dead-letter list, requeue and cancel are the platform owner's, on brand paths.** The permission table (PRD 16.1) has no job permission. These routes use `see_other_brands` (platform owner only) under `/brands/:brandId/jobs/...`, so the brand check and row-level security still apply. A brand admin does not see them until the owner decides otherwise (dashboard milestone). Proposed: accept.
8. **Until n8n triggers exist, the worker process runs the reconciliation sweep on a timer.** Every 5 minutes it calls the core's sweep endpoint, which marks "started" model calls older than their class's expiry as "unknown". In milestone 6 the n8n schedule replaces the timer. Proposed: accept.
9. **Backpressure limit.** The core refuses to create a production or bulk job (answers `queue_busy`, 503) when 2000 jobs of that class are waiting. The number is configuration, not code, and is above the 500 in test 29. Proposed: accept.
10. **Worker calls skip the browser origin check, and only those.** The request guard exists to stop another site making a signed-in browser act; a worker call has no cookie and no `Origin`. A request whose path starts `/api/v1/worker/` and that carries an `Authorization` header skips the origin and token check and is then refused unless the worker credential is right. A request without that header is guarded exactly as before. Proposed: accept.

## Review Focus

1. **A token for job A used against job B** (same brand, then another brand) must not return B's input or accept B's results. Task 6.
2. **A superseded attempt**: its token is still validly signed and unexpired, yet every call (checkpoint, model-call registration, result) is refused and recorded, and the new attempt is untouched. Task 6.
3. **A result posted twice** returns the first outcome with no second application; a different result for a finished job is refused; a result of a type other than the token's is refused; a result posted while the job is held is stored and not applied. Task 8.
4. **A crash between the provider's reply and the checkpoint**: the retry resends, is flagged, both calls are in the ledger, one result is applied. Tasks 7 and 9.
5. **A step with a saved checkpoint is not sent to the provider again**, even after a crash and a reclaim. Tasks 7 and 9.
6. **A brand with 500 waiting production jobs** never holds more than its cap and never delays another brand's interactive or production job beyond its class limits, with one worker process and with two. Task 4.
7. **A job whose business transaction rolls back leaves no queue row**; one that commits leaves exactly one. Tasks 1 and 5.
8. **A price or a rate that is missing** never blocks a checkpoint or loses a model-call row. Task 7.
9. **The worker credential and the attempt-token secret** are different values and a token cannot be forged with the worker credential. Task 6.

---

## File structure

```
packages/queue/                         NEW workspace (@mkt/queue); the only place that imports pg-boss
  package.json
  src/classes.ts                        the four classes: settings, queue names, caps
  src/queue.ts                          createQueue(): install, send, work, state, depth, dead letters, watchdog
  src/install.ts                        installQueue(adminUrl): pgboss schema + grants for mkt_app and mkt_queue
  src/testing.ts                        createQueueTestDatabase(): test database with the queue installed
  src/index.ts
  test/*.test.ts
packages/db/migrations/0011_work_engine.sql        NEW tables, policies, grants, definer functions
packages/db/migrations/0012_model_cost.sql         NEW model_price, record_fx_rate, cost functions' grants
apps/core/src/jobs/token.ts             attempt token: sign, verify
apps/core/src/jobs/money.ts             token cost and currency conversion, pure
apps/core/src/jobs/service.ts           createJob, startAttempt, registerModelCall, saveCheckpoint, postResult, control
apps/core/src/jobs/dead.ts              dead-letter list, requeue, cancel, reconcile, watchdog
apps/core/src/jobs/results.ts           result-type registry
apps/core/src/routes/worker.ts          /worker/... routes (worker credential, attempt token)
apps/core/src/routes/jobs.ts            /brands/:brandId/jobs/... routes
apps/core/src/access/worker-auth.ts     the two new access kinds
apps/worker/                            NEW workspace (@mkt/worker)
  package.json
  src/main.ts, config.ts, core-client.ts, runner.ts, model.ts, anthropic.ts, standin.ts, maintenance.ts
  test/*.test.ts
```

Existing files changed: `apps/core/src/config.ts`, `.env.example`, `apps/core/src/ports.ts`, `apps/core/src/core.ts`, `apps/core/src/api.ts`, `apps/core/src/guard.ts`, `apps/core/src/access/routes.ts`, `apps/core/src/audit/db-audit.ts`, `apps/core/test/support.ts`, the route-table tests, `packages/db/test/isolation-catalog.test.ts`, `packages/db/test/harness.test.ts`, `docs/database/2026-10-04-database-schema.md`, `docs/progress.md`.

---

### Task 1: The queue package, its schema and what each role may do

**Files:**

- Create: `packages/queue/package.json`, `packages/queue/src/classes.ts`, `packages/queue/src/install.ts`, `packages/queue/src/testing.ts`, `packages/queue/src/index.ts`
- Test: `packages/queue/test/classes.test.ts`, `packages/queue/test/roles.test.ts`
- Modify: `packages/db/test/harness.test.ts` only if it lists schemas of a test database that now has `pgboss` (it must not: `createTestDatabase` is unchanged)

**Interfaces:**

- Consumes: `createTestDatabase`, `TestDatabase` from `@mkt/db/testing`; `requireDatabase` from `@mkt/test-support`.
- Produces:
  - `JOB_CLASSES`, `type JobClass`, `CLASS_SETTINGS: Record<JobClass, ClassSettings>`, `perProcessCap(cap: number, processes: number): number`
  - `installQueue(adminUrl: string): Promise<void>`: creates the `pgboss` schema, the eight queues, and the grants; safe to run twice
  - `createQueueTestDatabase(): Promise<TestDatabase>`: `createTestDatabase()` then `installQueue(db.urlFor('migration'))`
  - `executeSqlOn(client: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }): { executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }`

- [ ] **Step 1: Write the class settings test**

`packages/queue/test/classes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CLASS_SETTINGS, JOB_CLASSES, perProcessCap } from '../src/classes.ts'

describe('the four job classes (spec 9.3)', () => {
  it('has exactly the specified settings', () => {
    const table = JOB_CLASSES.map((c) => {
      const s = CLASS_SETTINGS[c]
      return [c, s.heartbeatSeconds, s.expireInSeconds, s.retryLimit + 1, s.brandCap, s.notify, s.pollingIntervalSeconds]
    })
    expect(table).toEqual([
      ['interactive', 60, 300, 3, 2, true, 2],
      ['publishing', 60, 600, 5, 2, true, 2],
      ['production', 90, 1800, 3, 3, false, 2],
      ['bulk', 90, 7200, 3, 1, false, 2],
    ])
  })

  it('names one queue and one dead-letter queue per class, all different', () => {
    const names = JOB_CLASSES.flatMap((c) => [CLASS_SETTINGS[c].queue, CLASS_SETTINGS[c].deadLetter])
    expect(new Set(names).size).toBe(8)
  })

  it('divides a brand cap between worker processes and never exceeds it', () => {
    expect(perProcessCap(3, 1)).toBe(3)
    expect(perProcessCap(3, 2)).toBe(1)
    expect(perProcessCap(4, 2)).toBe(2)
    expect(() => perProcessCap(1, 2)).toThrow(/smaller than the number of processes/)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run (server): `npx vitest run packages/queue/test/classes.test.ts`. Expected: FAIL, `Cannot find module '../src/classes.ts'`.

- [ ] **Step 3: Create the package and the settings**

`packages/queue/package.json`:

```json
{
  "name": "@mkt/queue",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts"
  },
  "dependencies": {
    "pg": "8.23.0",
    "pg-boss": "12.30.0"
  },
  "devDependencies": {
    "@mkt/db": "*",
    "@mkt/test-support": "*"
  }
}
```

`packages/queue/src/classes.ts`:

```ts
export const JOB_CLASSES = ['interactive', 'publishing', 'production', 'bulk'] as const
export type JobClass = (typeof JOB_CLASSES)[number]

export interface ClassSettings {
  readonly queue: string
  readonly deadLetter: string
  // The allowed gap between heartbeats; the library refreshes inside it.
  readonly heartbeatSeconds: number
  readonly expireInSeconds: number
  // The library counts retries, not attempts: attempts = retryLimit + 1.
  readonly retryLimit: number
  readonly retryDelaySeconds: number
  readonly notify: boolean
  readonly pollingIntervalSeconds: number
  readonly brandCap: number
}

// Spec 9.3 and 9.2. The dead-letter queue is one per class (architecture 7.1).
export const CLASS_SETTINGS: Record<JobClass, ClassSettings> = {
  interactive: { queue: 'job-interactive', deadLetter: 'dead-interactive', heartbeatSeconds: 60, expireInSeconds: 300, retryLimit: 2, retryDelaySeconds: 15, notify: true, pollingIntervalSeconds: 2, brandCap: 2 },
  publishing: { queue: 'job-publishing', deadLetter: 'dead-publishing', heartbeatSeconds: 60, expireInSeconds: 600, retryLimit: 4, retryDelaySeconds: 15, notify: true, pollingIntervalSeconds: 2, brandCap: 2 },
  production: { queue: 'job-production', deadLetter: 'dead-production', heartbeatSeconds: 90, expireInSeconds: 1800, retryLimit: 2, retryDelaySeconds: 30, notify: false, pollingIntervalSeconds: 2, brandCap: 3 },
  bulk: { queue: 'job-bulk', deadLetter: 'dead-bulk', heartbeatSeconds: 90, expireInSeconds: 7200, retryLimit: 2, retryDelaySeconds: 60, notify: false, pollingIntervalSeconds: 2, brandCap: 1 },
}

// Spec 9.3: the per-process limit is the cap divided between the worker processes for the class; a cap
// smaller than the number of processes is not allowed. Rounding down keeps the total at or under the cap.
export function perProcessCap(cap: number, processes: number): number {
  if (!Number.isInteger(processes) || processes < 1) throw new Error('processes must be a whole number of at least 1')
  if (cap < processes) throw new Error(`a cap of ${cap} is smaller than the number of processes (${processes})`)
  return Math.floor(cap / processes)
}
```

`packages/queue/src/index.ts`:

```ts
export * from './classes.ts'
export * from './install.ts'
```

Run `npm install` (server, so the workspace is linked), then `npx vitest run packages/queue/test/classes.test.ts`. Expected: PASS.

- [ ] **Step 4: Write the roles test**

`packages/queue/test/roles.test.ts`:

```ts
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import PgBoss from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase } from '@mkt/test-support'
import type { TestDatabase } from '@mkt/db/testing'
import { executeSqlOn } from '../src/install.ts'
import { createQueueTestDatabase } from '../src/testing.ts'

let db: TestDatabase
let boss: PgBoss
let app: pg.Pool
let queueRole: pg.Pool

beforeAll(async () => {
  await requireDatabase()
  db = await createQueueTestDatabase()
  // The runtime library instance: queue role, no schema creation, no migration, no supervision.
  boss = new PgBoss({ connectionString: db.urlFor('queue'), schema: 'pgboss', migrate: false, createSchema: false, supervise: false, schedule: false })
  boss.on('error', () => {})
  await boss.start()
  app = new pg.Pool({ connectionString: db.urlFor('app') })
  queueRole = new pg.Pool({ connectionString: db.urlFor('queue') })
})

afterAll(async () => {
  await boss?.stop({ graceful: false })
  await app?.end()
  await queueRole?.end()
  await db?.drop()
})

describe('the queue schema and the roles', () => {
  it('lets the application role create a job inside its own transaction: rolled back leaves nothing, committed leaves one', async () => {
    const queue = 'job-production'
    const key = randomUUID()
    const rolledBack = randomUUID()
    const committed = randomUUID()

    const a = await app.connect()
    try {
      await a.query('begin')
      await boss.send(queue, {}, { id: rolledBack, group: { id: key }, db: executeSqlOn(a) })
      await a.query('rollback')
      await a.query('begin')
      await boss.send(queue, {}, { id: committed, group: { id: key }, db: executeSqlOn(a) })
      await a.query('commit')
    } finally {
      a.release()
    }
    expect(await boss.getJobById(queue, rolledBack)).toBeNull()
    expect((await boss.getJobById(queue, committed))?.state).toBe('created')
  })

  it('lets the queue role claim and finish a job', async () => {
    const queue = 'job-bulk'
    const id = randomUUID()
    const a = await app.connect()
    try {
      await a.query('begin')
      await boss.send(queue, {}, { id, group: { id: randomUUID() }, db: executeSqlOn(a) })
      await a.query('commit')
    } finally {
      a.release()
    }
    const [job] = await boss.fetch(queue)
    expect(job?.id).toBe(id)
    await boss.complete(queue, id)
    expect((await boss.getJobById(queue, id))?.state).toBe('completed')
  })

  it('refuses the application role every change to a job except creating it', async () => {
    await expect(app.query('delete from pgboss.job')).rejects.toThrow(/permission denied/)
    await expect(app.query("update pgboss.job set state = 'completed'")).rejects.toThrow(/permission denied/)
  })

  it('keeps every business table out of the queue role (acceptance test 5)', async () => {
    for (const table of ['app.brand', 'app.job_input', 'app.content_item', 'app.membership']) {
      await expect(queueRole.query(`select 1 from ${table} limit 1`)).rejects.toThrow(/permission denied/)
    }
  })

  it('holds no client content or business input in a queue row (acceptance test 5)', async () => {
    const { rows } = await db.admin.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'pgboss' and table_name = 'job' order by 1`,
    )
    // The data column exists; what is put in it is fixed by the send helper and tested in task 3.
    expect(rows.map((r) => r.column_name)).toContain('data')
  })

  it('is safe to install twice', async () => {
    const { installQueue } = await import('../src/install.ts')
    await expect(installQueue(db.urlFor('migration'))).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 5: Run it to see it fail**

Run (server): `npx vitest run packages/queue/test/roles.test.ts`. Expected: FAIL, `Cannot find module '../src/testing.ts'`.

- [ ] **Step 6: Write the installer and the test database**

`packages/queue/src/install.ts`:

```ts
import pg from 'pg'
import PgBoss from 'pg-boss'
import { CLASS_SETTINGS, JOB_CLASSES } from './classes.ts'

export const QUEUE_SCHEMA = 'pgboss'

// pg-boss takes an object with executeSql to run a send on the caller's own connection, which is how a
// job joins the caller's transaction (trial result 1).
export function executeSqlOn(client: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }) {
  return {
    executeSql: async (text: string, values?: unknown[]) => {
      const result = await client.query(text, values)
      return { rows: result.rows }
    },
  }
}

// What each run-time role may do in the queue schema (database schema 11.1):
// the queue role claims and updates jobs; the application role may only create them.
const GRANTS = `
grant usage on schema ${QUEUE_SCHEMA} to mkt_queue, mkt_app;
grant select, insert, update, delete on all tables in schema ${QUEUE_SCHEMA} to mkt_queue;
grant usage, select on all sequences in schema ${QUEUE_SCHEMA} to mkt_queue;
grant execute on all functions in schema ${QUEUE_SCHEMA} to mkt_queue;
grant insert on ${QUEUE_SCHEMA}.job to mkt_app;
grant select on ${QUEUE_SCHEMA}.queue to mkt_app;
`

// Run at deployment, and by the test harness, as the role that owns the database (never at run time).
export async function installQueue(adminUrl: string): Promise<void> {
  const boss = new PgBoss({ connectionString: adminUrl, schema: QUEUE_SCHEMA })
  boss.on('error', () => {})
  await boss.start()
  try {
    for (const jobClass of JOB_CLASSES) {
      const s = CLASS_SETTINGS[jobClass]
      // The dead-letter queue must exist before the queue that points at it.
      if (!(await boss.getQueue(s.deadLetter))) await boss.createQueue(s.deadLetter)
      if (!(await boss.getQueue(s.queue))) {
        await boss.createQueue(s.queue, {
          deadLetter: s.deadLetter,
          heartbeatSeconds: s.heartbeatSeconds,
          expireInSeconds: s.expireInSeconds,
          retryLimit: s.retryLimit,
          retryDelay: s.retryDelaySeconds,
          retryBackoff: true,
          notify: s.notify,
        })
      }
    }
  } finally {
    await boss.stop({ graceful: false })
  }
  const pool = new pg.Pool({ connectionString: adminUrl })
  try {
    await pool.query(GRANTS)
  } finally {
    await pool.end()
  }
}
```

`packages/queue/src/testing.ts`:

```ts
import { createTestDatabase, type TestDatabase } from '@mkt/db/testing'
import { installQueue } from './install.ts'

export async function createQueueTestDatabase(): Promise<TestDatabase> {
  const db = await createTestDatabase()
  try {
    await installQueue(db.urlFor('migration'))
  } catch (error) {
    await db.drop()
    throw error
  }
  return db
}
```

Add `export * from './testing.ts'` is NOT added to `index.ts` (the testing helper stays under `@mkt/queue/testing`).

- [ ] **Step 7: Run it and settle the grants**

Run (server): `npx vitest run packages/queue/test/roles.test.ts`. Expected: PASS.

If a test fails with `permission denied for table X` or `for function Y`, or the library's own option names differ from those written here (`migrate`, `createSchema`, `supervise`, `schedule`, `retryBackoff`, `heartbeatSeconds`), read the typed `ConstructorOptions` and `Queue` types in `node_modules/pg-boss` and use the names it declares; the tests fix the behaviour, not the spelling. For a missing right, add the narrowest grant to `GRANTS` (`select` before `update`, never `delete` for the application role) and leave a one-line comment saying which call needed it. The refusal test in this file must keep passing: the application role may not update or delete a job.

- [ ] **Step 8: Commit**

```bash
git add packages/queue package.json package-lock.json
git commit -m "feat(queue): the queue package, its schema and what each role may do"
```

---

### Task 2: The work-engine tables

**Files:**

- Create: `packages/db/migrations/0011_work_engine.sql`, `packages/db/migrations/0012_model_cost.sql`
- Test: `packages/db/test/work-engine-tables.test.ts`
- Modify: `packages/db/test/isolation-catalog.test.ts` (raise the floors), `packages/db/src/testing.ts` (two seed helpers)

**Interfaces:**

- Consumes: the enums `app.run_state`, `app.job_class`, `app.attempt_state`, `app.model_call_status`, `app.actor_kind` (migration 0002).
- Produces (SQL): tables `app.agent_definition_version`, `app.run`, `app.job_input`, `app.job_attempt`, `app.job_control`, `app.model_call`, `app.cost_ledger`, `app.fx_rate`, `app.model_price`; functions `app.job_brand(uuid) returns uuid`, `app.sweep_model_calls(app.job_class, timestamptz) returns integer`, `app.record_fx_rate(date, bigint, text) returns uuid`.
- Produces (TypeScript, `@mkt/db/testing`): `seedDefinition(db: TestDatabase, agent?: string): Promise<string>` returns a definition-version ID; `seedRun(db: TestDatabase, brandId: string, definitionId: string): Promise<string>` returns a run ID.

- [ ] **Step 1: Write the failing test**

`packages/db/test/work-engine-tables.test.ts`:

```ts
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
    const swept = await app.query<{ n: number }>(`select app.sweep_model_calls('production', now() - interval '1 hour') as n`)
    expect(swept.rows[0]!.n).toBeGreaterThanOrEqual(1)
    const rows = await withBrand(app, A, (c) =>
      c.query<{ step: string; status: string }>(`select step, status from app.model_call where job_id = $1 order by step`, [jobId]),
    )
    expect(rows.rows).toEqual([
      { step: 'new', status: 'started' },
      { step: 'old', status: 'unknown' },
    ])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run (server): `npx vitest run packages/db/test/work-engine-tables.test.ts`. Expected: FAIL, `seedDefinition` is not exported.

- [ ] **Step 3: Write the seed helpers**

Append to `packages/db/src/testing.ts`:

```ts
// A definition version for tests that need a run. Not brand-scoped, so it is written as the superuser.
export async function seedDefinition(db: TestDatabase, agent = 'test-agent'): Promise<string> {
  const { rows } = await db.admin.query<{ id: string }>(
    `insert into app.agent_definition_version (agent, version, model, effort, files_hash)
     values ($1, (select coalesce(max(version), 0) + 1 from app.agent_definition_version where agent = $1), 'claude-opus-5-5', 'low', 'test')
     returning id`,
    [agent],
  )
  return rows[0]!.id
}

export async function seedRun(db: TestDatabase, brandId: string, definitionId: string): Promise<string> {
  const { rows } = await db.admin.query<{ id: string }>(
    `insert into app.run (brand_id, agent, definition_version_id, state, started_by_kind)
     values ($1, 'test-agent', $2, 'running', 'system') returning id`,
    [brandId, definitionId],
  )
  return rows[0]!.id
}
```

- [ ] **Step 4: Write migration 0011**

`packages/db/migrations/0011_work_engine.sql`:

```sql
-- Up Migration
-- The tables of database schema 7 (jobs, attempts, model calls, cost). The queue's own tables are the
-- library's, in schema pgboss, installed at deployment.

create table app.agent_definition_version (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  version integer not null,
  model text not null,
  effort text not null,
  files_hash text not null,
  live boolean not null default false,
  released_by uuid,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  unique (agent, version)
);
create unique index agent_definition_one_live on app.agent_definition_version (agent) where live;

create table app.run (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  agent text not null,
  definition_version_id uuid not null references app.agent_definition_version (id),
  state app.run_state not null default 'created',
  started_by_kind app.actor_kind not null,
  started_by_id uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id)
);

-- expected_result_type, result_type, outcome, held_result and finished_at are additions to the spec's columns (plan decision 4).
create table app.job_input (
  job_id uuid primary key,
  brand_id uuid not null,
  run_id uuid not null,
  class app.job_class not null,
  input jsonb not null,
  saved_steps jsonb not null default '[]'::jsonb,
  expected_result_type text not null,
  result_type text,
  result_hash text,
  outcome jsonb,
  held_result jsonb,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (brand_id, job_id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, run_id) references app.run (brand_id, id)
);

create table app.job_attempt (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  job_id uuid not null,
  attempt_number integer not null,
  worker_id text not null,
  token_id uuid not null unique,
  state app.attempt_state not null default 'active',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (job_id, attempt_number),
  unique (brand_id, id),
  foreign key (brand_id, job_id) references app.job_input (brand_id, job_id)
);
create unique index job_attempt_one_active on app.job_attempt (job_id) where state = 'active';

create table app.job_control (
  job_id uuid primary key,
  brand_id uuid not null,
  cancel_requested boolean not null default false,
  held boolean not null default false,
  dead_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (brand_id, job_id) references app.job_input (brand_id, job_id)
);

create table app.fx_rate (
  id uuid primary key default gen_random_uuid(),
  rate_date date not null,
  base_currency text not null default 'USD',
  quote_currency text not null default 'INR',
  rate_micros bigint not null check (rate_micros > 0),
  source text not null,
  fetched_at timestamptz not null default now(),
  unique (rate_date, base_currency, quote_currency)
);

create table app.model_call (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  run_id uuid not null,
  job_id uuid not null,
  attempt_id uuid not null,
  step text not null,
  request_hash text not null,
  status app.model_call_status not null default 'started',
  possible_duplicate boolean not null default false,
  provider_message_id text,
  provider_request_id text,
  model text not null,
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  cache_read_tokens integer check (cache_read_tokens >= 0),
  cache_write_tokens integer check (cache_write_tokens >= 0),
  charged_micros bigint check (charged_micros >= 0),
  charged_currency text,
  usd_micros bigint check (usd_micros >= 0),
  inr_micros bigint check (inr_micros >= 0),
  fx_rate_id uuid references app.fx_rate (id),
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, run_id) references app.run (brand_id, id),
  foreign key (brand_id, job_id) references app.job_input (brand_id, job_id),
  foreign key (brand_id, attempt_id) references app.job_attempt (brand_id, id)
);
create index model_call_duplicate_check on app.model_call (job_id, step, request_hash);
create index model_call_reconcile on app.model_call (status, started_at);

create table app.cost_ledger (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  run_id uuid,
  agent text not null,
  deliverable text,
  model_call_id uuid,
  charged_micros bigint not null check (charged_micros >= 0),
  charged_currency text not null,
  usd_micros bigint not null check (usd_micros >= 0),
  inr_micros bigint not null check (inr_micros >= 0),
  fx_rate_id uuid not null references app.fx_rate (id),
  at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, run_id) references app.run (brand_id, id),
  foreign key (brand_id, model_call_id) references app.model_call (brand_id, id)
);
create unique index cost_ledger_one_per_call on app.cost_ledger (model_call_id) where model_call_id is not null;
create index cost_ledger_brand_at on app.cost_ledger (brand_id, at);

-- Row-level security on the new brand tables, the same policy as migration 0004.
do $$
declare t text;
begin
  foreach t in array array['run','job_input','job_attempt','job_control','model_call','cost_ledger']
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format(
      'create policy brand_isolation on app.%I using (brand_id = nullif(current_setting(''app.brand_id'', true), '''')::uuid) with check (brand_id = nullif(current_setting(''app.brand_id'', true), '''')::uuid)',
      t);
  end loop;
end $$;

grant select, insert, update, delete on app.run, app.job_input, app.job_attempt, app.job_control, app.model_call to mkt_app;
-- A cost row is written once.
grant select, insert on app.cost_ledger to mkt_app;
-- Shared reference data: read by the application; written by the release step and by named functions only.
grant select on app.agent_definition_version, app.fx_rate to mkt_app, mkt_readonly, mkt_owner_view;
grant select on app.run, app.job_input, app.job_attempt, app.job_control, app.model_call, app.cost_ledger to mkt_readonly;

-- Definer functions: work that has no brand yet, or crosses brands.
grant create on schema app to mkt_definer;

create policy definer_read_job_input on app.job_input for select to mkt_definer using (true);
grant select on app.job_input to mkt_definer;

create function app.job_brand(p_job uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, app
as $$ select brand_id from app.job_input where job_id = p_job $$;
alter function app.job_brand(uuid) owner to mkt_definer;
revoke all on function app.job_brand(uuid) from public;
grant execute on function app.job_brand(uuid) to mkt_app;

create policy definer_update_model_call on app.model_call for update to mkt_definer using (true) with check (true);
create policy definer_read_model_call on app.model_call for select to mkt_definer using (true);
grant select, update on app.model_call to mkt_definer;

-- Marks calls of one job class still "started" from before the cutoff as "unknown" (spec 9.5, reconciliation:
-- older than the class's expiry, so the caller passes one cutoff per class).
create function app.sweep_model_calls(p_class app.job_class, p_cutoff timestamptz) returns integer
language plpgsql security definer set search_path = pg_catalog, app
as $$
declare n integer;
begin
  update app.model_call m set status = 'unknown', finished_at = now()
    from app.job_input j
   where j.job_id = m.job_id and j.class = p_class
     and m.status = 'started' and m.started_at < p_cutoff;
  get diagnostics n = row_count;
  return n;
end $$;
alter function app.sweep_model_calls(app.job_class, timestamptz) owner to mkt_definer;
revoke all on function app.sweep_model_calls(app.job_class, timestamptz) from public;
grant execute on function app.sweep_model_calls(app.job_class, timestamptz) to mkt_app;

-- One rate a day; entering the same day again replaces nothing and returns the stored row.
create function app.record_fx_rate(p_date date, p_rate_micros bigint, p_source text) returns uuid
language plpgsql security definer set search_path = pg_catalog, app
as $$
declare r uuid;
begin
  insert into app.fx_rate (rate_date, rate_micros, source) values (p_date, p_rate_micros, p_source)
  on conflict (rate_date, base_currency, quote_currency) do nothing
  returning id into r;
  if r is null then
    select id into r from app.fx_rate
     where rate_date = p_date and base_currency = 'USD' and quote_currency = 'INR';
  end if;
  return r;
end $$;
alter function app.record_fx_rate(date, bigint, text) owner to mkt_definer;
revoke all on function app.record_fx_rate(date, bigint, text) from public;
grant execute on function app.record_fx_rate(date, bigint, text) to mkt_owner_view;

grant insert on app.fx_rate to mkt_definer;
revoke create on schema app from mkt_definer;

-- Down Migration
drop function app.record_fx_rate(date, bigint, text);
drop function app.sweep_model_calls(app.job_class, timestamptz);
drop function app.job_brand(uuid);
drop table app.cost_ledger;
drop table app.model_call;
drop table app.fx_rate;
drop table app.job_control;
drop table app.job_attempt;
drop table app.job_input;
drop table app.run;
drop table app.agent_definition_version;
```

`packages/db/migrations/0012_model_cost.sql`:

```sql
-- Up Migration
-- Model prices (plan decision 5): data the owner confirms from the provider's own price page.
-- Millionths of a US dollar per million tokens. Not brand-scoped; written only by the release step.
create table app.model_price (
  id uuid primary key default gen_random_uuid(),
  model text not null,
  effective_from date not null,
  input_micros bigint not null check (input_micros >= 0),
  output_micros bigint not null check (output_micros >= 0),
  cache_read_micros bigint not null check (cache_read_micros >= 0),
  cache_write_micros bigint not null check (cache_write_micros >= 0),
  source text not null,
  created_at timestamptz not null default now(),
  unique (model, effective_from)
);
grant select on app.model_price to mkt_app, mkt_readonly, mkt_owner_view;

-- Down Migration
drop table app.model_price;
```

- [ ] **Step 5: Raise the catalog floors**

In `packages/db/test/isolation-catalog.test.ts`, raise the three floors the survey found (`>= 15` scoped tables, `>= 13` with ids, `>= 10` brand foreign keys) by the counts this migration adds: six scoped tables, five with ids (`run`, `job_attempt`, `model_call`, `cost_ledger` and none for `job_input` and `job_control`, which have no `id`), and seven foreign keys between brand tables. Run the file first to see what the test reports, then set each floor to the actual new total.

- [ ] **Step 6: Run the database tests**

Run (server): `npx vitest run packages/db`. Expected: PASS, including `work-engine-tables.test.ts`, the isolation catalog and behaviour tests (the queue role still reads no business table; no new function in `app` is executable by PUBLIC).

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): runs, jobs, attempts, model calls, cost ledger, exchange rates and model prices"
```

---

### Task 3: The queue interface

**Files:**

- Create: `packages/queue/src/queue.ts`
- Modify: `packages/queue/src/index.ts`
- Test: `packages/queue/test/queue.test.ts`

**Interfaces:**

- Consumes: `CLASS_SETTINGS`, `JobClass`, `perProcessCap`, `executeSqlOn` (Task 1).
- Produces:

```ts
export interface QueueJob { id: string; jobClass: JobClass }
export interface Queue {
  // Creates a job on the caller's own connection, so it commits or rolls back with the caller's change.
  send(client: SqlClient, input: { jobId: string; jobClass: JobClass; scheduleKey: string }): Promise<void>
  // Starts claiming a class. The handler's resolve completes the job; its throw fails it (retry, then dead letter).
  work(jobClass: JobClass, options: { processes: number }, handler: (job: QueueJob) => Promise<void>): Promise<void>
  state(jobClass: JobClass, jobId: string): Promise<'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed' | null>
  depth(jobClass: JobClass): Promise<number>               // waiting jobs: created or retry
  deadJobs(jobClass: JobClass): Promise<string[]>          // job IDs in the class's dead-letter queue
  requeue(jobClass: JobClass, jobId: string): Promise<void>
  cancel(jobClass: JobClass, jobId: string): Promise<void>
  watchdog(now: Date, limits: { maxWaitSeconds: Record<JobClass, number> }): Promise<{ waiting: string[]; running: string[] }>
  stop(): Promise<void>
}
export type SqlClient = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }
export function openQueue(queueUrl: string, options?: { supervise?: boolean }): Promise<Queue>
```

- [ ] **Step 1: Write the failing test**

`packages/queue/test/queue.test.ts`:

```ts
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase, sleep } from '@mkt/test-support'
import type { TestDatabase } from '@mkt/db/testing'
import { openQueue, type Queue } from '../src/queue.ts'
import { createQueueTestDatabase } from '../src/testing.ts'

let db: TestDatabase
let queue: Queue
let app: pg.Pool

beforeAll(async () => {
  await requireDatabase()
  db = await createQueueTestDatabase()
  queue = await openQueue(db.urlFor('queue'), { supervise: true })
  app = new pg.Pool({ connectionString: db.urlFor('app') })
})
afterAll(async () => {
  await queue?.stop()
  await app?.end()
  await db?.drop()
})

async function send(jobClass: 'interactive' | 'publishing' | 'production' | 'bulk', key = randomUUID(), id = randomUUID()) {
  const client = await app.connect()
  try {
    await client.query('begin')
    await queue.send(client, { jobId: id, jobClass, scheduleKey: key })
    await client.query('commit')
  } finally {
    client.release()
  }
  return id
}

async function until(check: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error('condition not reached in time')
}

describe('the queue interface', () => {
  it('puts only a job ID, a class queue and a scheduling key in the queue row', async () => {
    const id = await send('bulk')
    const { rows } = await db.admin.query<{ name: string; data: unknown; group_id: string | null }>(
      `select name, data, group_id from pgboss.job where id = $1`,
      [id],
    )
    expect(rows[0]?.name).toBe('job-bulk')
    expect(rows[0]?.data).toEqual({ jobId: id })
    expect(rows[0]?.group_id).not.toBeNull()
    await queue.cancel('bulk', id)
  })

  it('runs a job, completes it when the handler resolves, and reports its state', async () => {
    const seen: string[] = []
    await queue.work('interactive', { processes: 1 }, async (job) => {
      seen.push(job.id)
    })
    const id = await send('interactive')
    await until(async () => (await queue.state('interactive', id)) === 'completed')
    expect(seen).toContain(id)
  })

  it('counts waiting jobs for backpressure', async () => {
    const before = await queue.depth('bulk')
    await send('bulk')
    await send('bulk')
    expect(await queue.depth('bulk')).toBe(before + 2)
  })

  it('moves a job that keeps failing to the dead-letter list, and requeues it', async () => {
    let runs = 0
    let fail = true
    await queue.work('publishing', { processes: 1 }, async () => {
      runs += 1
      if (fail) throw new Error('boom')
    })
    const id = await send('publishing')
    await until(async () => (await queue.deadJobs('publishing')).includes(id), 120_000)
    expect(runs).toBeGreaterThanOrEqual(5)
    fail = false
    await queue.requeue('publishing', id)
    await until(async () => (await queue.state('publishing', id)) === 'completed', 60_000)
    expect(await queue.deadJobs('publishing')).not.toContain(id)
  }, 240_000)

  it('refuses a cap smaller than the number of worker processes', async () => {
    await expect(queue.work('bulk', { processes: 2 }, async () => {})).rejects.toThrow(/smaller than the number of processes/)
  })
})
```

Note: the publishing class retries 5 times with a 15-second base delay and back-off, so the dead-letter test is slow at the spec's values. Step 4 scales the timings for the test database only.

- [ ] **Step 2: Run it to see it fail**

Run (server): `npx vitest run packages/queue/test/queue.test.ts`. Expected: FAIL, `Cannot find module '../src/queue.ts'`.

- [ ] **Step 3: Write the interface**

`packages/queue/src/queue.ts`:

```ts
import pg from 'pg'
import PgBoss from 'pg-boss'
import { CLASS_SETTINGS, JOB_CLASSES, perProcessCap, type JobClass } from './classes.ts'
import { executeSqlOn, QUEUE_SCHEMA } from './install.ts'

export type SqlClient = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }
export interface QueueJob {
  id: string
  jobClass: JobClass
}
export type JobState = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed'

export interface Queue {
  send(client: SqlClient, input: { jobId: string; jobClass: JobClass; scheduleKey: string }): Promise<void>
  work(jobClass: JobClass, options: { processes: number }, handler: (job: QueueJob) => Promise<void>): Promise<void>
  state(jobClass: JobClass, jobId: string): Promise<JobState | null>
  depth(jobClass: JobClass): Promise<number>
  deadJobs(jobClass: JobClass): Promise<string[]>
  requeue(jobClass: JobClass, jobId: string): Promise<void>
  cancel(jobClass: JobClass, jobId: string): Promise<void>
  watchdog(now: Date, limits: { maxWaitSeconds: Record<JobClass, number> }): Promise<{ waiting: string[]; running: string[] }>
  stop(): Promise<void>
}

export interface OpenOptions {
  // A worker process supervises (expiry, retry, archiving); the core's reading connection does not.
  supervise?: boolean
}

// Slots per process: always several, never one, so a brand at its limit cannot hold up another (spec 9.2).
const SLOTS_PER_CLASS = 6

export async function openQueue(queueUrl: string, options: OpenOptions = {}): Promise<Queue> {
  const boss = new PgBoss({
    connectionString: queueUrl,
    schema: QUEUE_SCHEMA,
    migrate: false,
    createSchema: false,
    supervise: options.supervise ?? false,
    schedule: false,
    useListenNotify: true,
  })
  boss.on('error', () => {})
  await boss.start()
  // Reads the library has no call for (depth, dead copies, the watchdog) go through the queue role directly.
  const reader = new pg.Pool({ connectionString: queueUrl, max: 2 })
  reader.on('error', () => {})

  return {
    async send(client, { jobId, jobClass, scheduleKey }) {
      // A job is a job ID (in the data, so a dead-letter copy can be traced back), a class (the queue) and a
      // scheduling key (the group). Nothing else: no client content, no business input (spec 9.1).
      await boss.send(CLASS_SETTINGS[jobClass].queue, { jobId }, { id: jobId, group: { id: scheduleKey }, db: executeSqlOn(client) })
    },

    async work(jobClass, { processes }, handler) {
      const s = CLASS_SETTINGS[jobClass]
      const cap = perProcessCap(s.brandCap, processes)
      await boss.work(
        s.queue,
        {
          localGroupConcurrency: cap,
          localConcurrency: SLOTS_PER_CLASS,
          pollingIntervalSeconds: s.pollingIntervalSeconds,
          // With notification the backstop poll is the class's 2 seconds; the notify poll is slow.
          notifyPollingIntervalSeconds: 30,
        },
        async (batch) => {
          // One job at a time per slot: a handler's throw fails only its own job.
          for (const job of batch) await handler({ id: job.id, jobClass })
        },
      )
    },

    async state(jobClass, jobId) {
      const job = await boss.getJobById(CLASS_SETTINGS[jobClass].queue, jobId)
      return (job?.state as JobState | undefined) ?? null
    },

    async depth(jobClass) {
      const { rows } = await reader.query<{ n: string }>(
        `select count(*) as n from ${QUEUE_SCHEMA}.job where name = $1 and state in ('created', 'retry')`,
        [CLASS_SETTINGS[jobClass].queue],
      )
      return Number(rows[0]?.n ?? 0)
    },

    async deadJobs(jobClass) {
      const { rows } = await reader.query<{ id: string }>(
        `select data->>'jobId' as id from ${QUEUE_SCHEMA}.job where name = $1 and state in ('created', 'retry')`,
        [CLASS_SETTINGS[jobClass].deadLetter],
      )
      return rows.map((r) => r.id)
    },

    async requeue(jobClass, jobId) {
      const s = CLASS_SETTINGS[jobClass]
      await boss.retry(s.queue, jobId)
      // The dead-letter copy has done its job: take it off the list.
      const { rows } = await reader.query<{ id: string }>(
        `select id from ${QUEUE_SCHEMA}.job where name = $1 and data->>'jobId' = $2 and state = 'created'`,
        [s.deadLetter, jobId],
      )
      for (const r of rows) await boss.cancel(s.deadLetter, r.id)
    },

    async cancel(jobClass, jobId) {
      await boss.cancel(CLASS_SETTINGS[jobClass].queue, jobId)
    },

    async watchdog(now, limits) {
      const waiting: string[] = []
      const running: string[] = []
      for (const jobClass of JOB_CLASSES) {
        const s = CLASS_SETTINGS[jobClass]
        const waitLimit = new Date(now.getTime() - limits.maxWaitSeconds[jobClass] * 1000)
        const runLimit = new Date(now.getTime() - s.expireInSeconds * 1000)
        const { rows } = await reader.query<{ id: string; state: string }>(
          `select id, state from ${QUEUE_SCHEMA}.job
            where name = $1 and ((state = 'created' and created_on < $2) or (state = 'active' and started_on < $3))`,
          [s.queue, waitLimit, runLimit],
        )
        for (const r of rows) (r.state === 'created' ? waiting : running).push(r.id)
      }
      return { waiting, running }
    },

    async stop() {
      await reader.end()
      await boss.stop({ graceful: false })
    },
  }
}
```

`packages/queue/src/index.ts`:

```ts
export * from './classes.ts'
export * from './install.ts'
export * from './queue.ts'
```

- [ ] **Step 4: Make the timing tests runnable in a reasonable time**

The class settings have a 15-second retry delay with back-off and heartbeat gaps of 60 and 90 seconds, so five publishing attempts, or a crash that must be noticed, take minutes. Give `installQueue` a second argument, `{ testScale?: number }` (default 1), that multiplies each class's `retryDelaySeconds` (rounded up, at least 1) and `heartbeatSeconds` (at least 10, the library's minimum) and `expireInSeconds` (at least 30) when the queues are created. `createQueueTestDatabase()` passes `{ testScale: 0.1 }`. `CLASS_SETTINGS` and the production install stay at scale 1, and `classes.test.ts` pins the table. In `installQueue`, replace `heartbeatSeconds: s.heartbeatSeconds` with `heartbeatSeconds: Math.max(10, Math.ceil(s.heartbeatSeconds * scale))`, `expireInSeconds: Math.max(30, Math.ceil(s.expireInSeconds * scale))` and `retryDelay: Math.max(1, Math.ceil(s.retryDelaySeconds * scale))`, with `const scale = options.testScale ?? 1`.

- [ ] **Step 5: Run it**

Run (server): `npx vitest run packages/queue`. Expected: PASS. If `getQueueStats`, `retry`, `getDb` or the stats field names differ in 12.30.0, read the installed typings and use what they declare; the behaviours in the test are what is fixed.

- [ ] **Step 6: Commit**

```bash
git add packages/queue
git commit -m "feat(queue): one interface over the library: send, work, state, depth, dead letters, watchdog"
```

---

### Task 4: One brand cannot delay another (acceptance test 29)

**Files:**

- Create: `packages/queue/test/fairness.test.ts`, `packages/queue/test/fairness-worker.ts`

**Interfaces:**

- Consumes: `openQueue`, `Queue`, `CLASS_SETTINGS`, `createQueueTestDatabase`.
- Produces: nothing new; this task proves behaviour.

- [ ] **Step 1: Write the worker script the test spawns**

`packages/queue/test/fairness-worker.ts`:

```ts
// Run as a separate process by fairness.test.ts. Claims production and interactive jobs, records
// each claim and release with the brand's scheduling key, then waits to be killed.
import { appendFile } from 'node:fs/promises'
import pg from 'pg'
import { openQueue } from '../src/queue.ts'

const [queueUrl, adminUrl, logFile, processes] = process.argv.slice(2) as [string, string, string, string]
// Reads the scheduling key as the database owner: the application role has no select on the queue's tables.
const admin = new pg.Pool({ connectionString: adminUrl })
const queue = await openQueue(queueUrl, { supervise: true })
const n = Number(processes)

async function keyOf(id: string): Promise<string> {
  const { rows } = await admin.query<{ key: string }>(`select group_id as key from pgboss.job where id = $1`, [id])
  return rows[0]?.key ?? ''
}

for (const jobClass of ['production', 'interactive'] as const) {
  await queue.work(jobClass, { processes: n }, async (job) => {
    const key = await keyOf(job.id)
    await appendFile(logFile, `${Date.now()} start ${jobClass} ${key} ${job.id}\n`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    await appendFile(logFile, `${Date.now()} end ${jobClass} ${key} ${job.id}\n`)
  })
}
process.send?.('ready')
```

- [ ] **Step 2: Write the test**

`packages/queue/test/fairness.test.ts`:

```ts
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase, sleep } from '@mkt/test-support'
import type { TestDatabase } from '@mkt/db/testing'
import { openQueue, type Queue } from '../src/queue.ts'
import { createQueueTestDatabase } from '../src/testing.ts'

let db: TestDatabase
let queue: Queue
let app: pg.Pool

beforeAll(async () => {
  await requireDatabase()
  db = await createQueueTestDatabase()
  queue = await openQueue(db.urlFor('queue'))
  app = new pg.Pool({ connectionString: db.urlFor('app') })
})
afterAll(async () => {
  await queue?.stop()
  await app?.end()
  await db?.drop()
})

async function sendMany(jobClass: 'production' | 'interactive', key: string, count: number): Promise<string[]> {
  const ids: string[] = []
  const client = await app.connect()
  try {
    await client.query('begin')
    for (let i = 0; i < count; i++) {
      const id = randomUUID()
      ids.push(id)
      await queue.send(client, { jobId: id, jobClass, scheduleKey: key })
    }
    await client.query('commit')
  } finally {
    client.release()
  }
  return ids
}

function peak(lines: string[], key: string, jobClass: string): number {
  let now = 0
  let max = 0
  for (const line of lines) {
    const [, kind, c, k] = line.split(' ')
    if (c !== jobClass || k !== key) continue
    now += kind === 'start' ? 1 : -1
    max = Math.max(max, now)
  }
  return max
}

for (const processes of [1, 2]) {
  describe(`acceptance test 29 with ${processes} worker process${processes > 1 ? 'es' : ''}`, () => {
    it('never runs more than the brand cap at once, and serves the other brand within its limits', async () => {
      const keyA = randomUUID()
      const keyB = randomUUID()
      const log = join(tmpdir(), `fair-${randomUUID()}.log`)
      await sendMany('production', keyA, 500)

      const workers = Array.from({ length: processes }, () =>
        fork(new URL('./fairness-worker.ts', import.meta.url).pathname, [db.urlFor('queue'), db.urlFor('migration'), log, String(processes)], {
          execArgv: ['--experimental-strip-types'],
        }),
      )
      try {
        await sleep(3000)
        const sentAt = Date.now()
        const b = [...(await sendMany('production', keyB, 3)), ...(await sendMany('interactive', keyB, 3))]
        // Brand B's six jobs must all finish while brand A still has hundreds waiting.
        const end = Date.now() + 60_000
        let lines: string[] = []
        while (Date.now() < end) {
          lines = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
          if (b.every((id) => lines.some((l) => l.includes(`end `) && l.includes(id)))) break
          await sleep(250)
        }
        expect(b.every((id) => lines.some((l) => l.includes('end ') && l.includes(id)))).toBe(true)
        // Brand B was served within 10 seconds although brand A had a 500-job backlog.
        const firstB = Math.min(...lines.filter((l) => l.includes(keyB) && l.includes(' start ')).map((l) => Number(l.split(' ')[0])))
        expect(firstB - sentAt).toBeLessThan(10_000)
        // Brand A never ran more than its cap (3 for production), summed over all processes.
        expect(peak(lines, keyA, 'production')).toBeLessThanOrEqual(3)
        expect(peak(lines, keyB, 'production')).toBeLessThanOrEqual(3)
        expect(peak(lines, keyB, 'interactive')).toBeLessThanOrEqual(2)
      } finally {
        for (const w of workers) w.kill('SIGKILL')
        await rm(log, { force: true })
      }
    }, 120_000)
  })
}
```

- [ ] **Step 3: Run it**

Run (server): `npx vitest run packages/queue/test/fairness.test.ts`. Expected: PASS for both process counts.

If the peak is above the cap with two processes, the division in `perProcessCap` is being applied to a cap of 3 split into 1 and 1 (total 2): that is within the cap and must pass. A peak above the cap means the per-process limit is not being set; fix `work()`, not the test. If brand B waits more than 10 seconds, check that `localConcurrency` is above the cap (six slots against a cap of three), as spec 9.2 requires.

- [ ] **Step 4: Commit**

```bash
git add packages/queue/test
git commit -m "test(queue): a large backlog in one brand does not delay another, with one and two worker processes"
```

---

### Task 5: Configuration, the attempt token, cost arithmetic, and job creation with its cause

**Files:**

- Create: `apps/core/src/jobs/token.ts`, `apps/core/src/jobs/money.ts`, `apps/core/src/jobs/service.ts`
- Modify: `apps/core/src/config.ts`, `.env.example`, `apps/core/src/ports.ts`, `apps/core/src/core.ts`, `apps/core/src/server.ts`, `apps/core/src/main.ts`, `apps/core/test/support.ts`, `apps/core/test/config.test.ts`, `apps/core/package.json`
- Test: `apps/core/test/attempt-token.test.ts`, `apps/core/test/money.test.ts`, `apps/core/test/jobs-create.test.ts`

**Interfaces:**

- Consumes: `Queue`, `JobClass`, `CLASS_SETTINGS` from `@mkt/queue`; `withBrand`, `Pool`, `PoolClient` from `@mkt/db`; `AppError` (`apps/core/src/errors.ts`).
- Produces:

```ts
// token.ts
export interface AttemptClaims { tokenId: string; jobId: string; brandId: string; attemptId: string; resultType: string; issuedAt: number; expiresAt: number }
export type TokenCheck =
  | { ok: true; claims: AttemptClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid' }
export function signAttemptToken(secret: string, claims: AttemptClaims): string
export function verifyAttemptToken(secret: string, token: string, nowSeconds: number): TokenCheck

// money.ts  (all amounts are bigint millionths)
export interface Price { inputMicros: bigint; outputMicros: bigint; cacheReadMicros: bigint; cacheWriteMicros: bigint }
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export function usdMicros(price: Price, usage: Usage): bigint
export function inrMicros(usd: bigint, rateMicros: bigint): bigint

// service.ts
export interface JobsDeps {
  pool: Pool
  queue: Queue
  audit: AuditSink
  workerSecret: string
  attemptTokenSecret: string
  backlogLimit: number
  now: () => Date
  results: ResultHandlers
}
export interface NewRun { agent: string; definitionVersionId: string; startedByKind: 'user' | 'agent' | 'system' | 'n8n'; startedById: string | null }
export function createRun(client: PoolClient, brandId: string, run: NewRun): Promise<string>
export interface NewJob { runId: string; jobClass: JobClass; input: unknown; expectedResultType: string }
export function createJob(client: PoolClient, deps: Pick<JobsDeps, 'queue' | 'backlogLimit'>, brandId: string, job: NewJob): Promise<string>
```

- [ ] **Step 1: Write the token test**

`apps/core/test/attempt-token.test.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signAttemptToken, verifyAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'

const SECRET = 'attempt-secret-'.padEnd(48, 'x')
const claims = (): AttemptClaims => ({
  tokenId: randomUUID(),
  jobId: randomUUID(),
  brandId: randomUUID(),
  attemptId: randomUUID(),
  resultType: 'test.echo',
  issuedAt: 1_000,
  expiresAt: 2_000,
})

describe('the attempt token (acceptance test 32, token half)', () => {
  it('verifies a token inside its times and returns its claims', () => {
    const c = claims()
    const result = verifyAttemptToken(SECRET, signAttemptToken(SECRET, c), 1_500)
    expect(result).toEqual({ ok: true, claims: c })
  })

  it('refuses an expired token and one not yet valid', () => {
    const token = signAttemptToken(SECRET, claims())
    expect(verifyAttemptToken(SECRET, token, 2_000)).toEqual({ ok: false, reason: 'expired' })
    expect(verifyAttemptToken(SECRET, token, 999)).toEqual({ ok: false, reason: 'not_yet_valid' })
  })

  it('refuses a token signed with another secret', () => {
    const token = signAttemptToken('another-secret-'.padEnd(48, 'y'), claims())
    expect(verifyAttemptToken(SECRET, token, 1_500)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('refuses a token with any field changed', () => {
    const token = signAttemptToken(SECRET, claims())
    const [version, payload, signature] = token.split('.') as [string, string, string]
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    for (const field of ['jobId', 'brandId', 'attemptId', 'resultType', 'tokenId', 'expiresAt']) {
      const changed = { ...decoded, [field]: field === 'expiresAt' ? 9_999_999 : randomUUID() }
      const forged = [version, Buffer.from(JSON.stringify(changed)).toString('base64url'), signature].join('.')
      expect(verifyAttemptToken(SECRET, forged, 1_500)).toEqual({ ok: false, reason: 'bad_signature' })
    }
  })

  it('refuses things that are not tokens', () => {
    for (const text of ['', 'abc', 'v1.a', 'v2.a.b', 'v1..', 'v1.!!!.???']) {
      expect(verifyAttemptToken(SECRET, text, 1_500)).toMatchObject({ ok: false })
    }
  })
})
```

- [ ] **Step 2: Write the cost arithmetic test**

`apps/core/test/money.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { inrMicros, usdMicros } from '../src/jobs/money.ts'

const price = { inputMicros: 4_000_000n, outputMicros: 20_000_000n, cacheReadMicros: 200_000n, cacheWriteMicros: 5_000_000n }

describe('costs in millionths', () => {
  it('prices tokens at the per-million rate', () => {
    // 1,000 input at $4/M = $0.004; 500 output at $20/M = $0.010
    expect(usdMicros(price, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(14_000n)
  })

  it('includes cache reads and writes', () => {
    // 1,000,000 cache reads at $0.20/M = $0.20; 100,000 cache writes at $5/M = $0.50
    expect(usdMicros(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 100_000 })).toBe(700_000n)
  })

  it('rounds half up and never produces a negative or fractional amount', () => {
    // 1 token at $4/M = 4 micros exactly; 1 token at $0.2/M = 0.2 micro, rounds to 0; 3 tokens = 0.6, rounds to 1
    expect(usdMicros(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0 })).toBe(0n)
    expect(usdMicros(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 0 })).toBe(1n)
    expect(usdMicros(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0n)
  })

  it('converts to rupees with the rate in millionths, rounding half up', () => {
    // 14,000 micro-dollars at 83.5 rupees per dollar
    expect(inrMicros(14_000n, 83_500_000n)).toBe(1_169_000n)
    // 1 micro-dollar at 83.5 = 83.5, rounds to 84
    expect(inrMicros(1n, 83_500_000n)).toBe(84n)
  })

  it('has no precision loss at large amounts', () => {
    expect(inrMicros(10_000_000_000_000n, 83_500_000n)).toBe(835_000_000_000_000n)
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run (server): `npx vitest run apps/core/test/attempt-token.test.ts apps/core/test/money.test.ts`. Expected: FAIL, modules not found.

- [ ] **Step 4: Write the token and the arithmetic**

`apps/core/src/jobs/token.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface AttemptClaims {
  tokenId: string
  jobId: string
  brandId: string
  attemptId: string
  resultType: string
  issuedAt: number // seconds since the epoch
  expiresAt: number
}

export type TokenCheck =
  | { ok: true; claims: AttemptClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid' }

const VERSION = 'v1'
const FIELDS = ['tokenId', 'jobId', 'brandId', 'attemptId', 'resultType'] as const

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`${VERSION}.${payload}`).digest('base64url')
}

export function signAttemptToken(secret: string, claims: AttemptClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${VERSION}.${payload}.${sign(secret, payload)}`
}

export function verifyAttemptToken(secret: string, token: string, nowSeconds: number): TokenCheck {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) return { ok: false, reason: 'malformed' }
  const [, payload, signature] = parts as [string, string, string]
  const expected = Buffer.from(sign(secret, payload))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_signature' }
  let claims: AttemptClaims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AttemptClaims
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const complete =
    FIELDS.every((f) => typeof claims[f] === 'string') &&
    typeof claims.issuedAt === 'number' &&
    typeof claims.expiresAt === 'number'
  if (!complete) return { ok: false, reason: 'malformed' }
  if (nowSeconds < claims.issuedAt) return { ok: false, reason: 'not_yet_valid' }
  if (nowSeconds >= claims.expiresAt) return { ok: false, reason: 'expired' }
  return { ok: true, claims }
}
```

`apps/core/src/jobs/money.ts`:

```ts
export interface Price {
  inputMicros: bigint
  outputMicros: bigint
  cacheReadMicros: bigint
  cacheWriteMicros: bigint
}
export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

const MILLION = 1_000_000n

// Round half up for non-negative numbers. Amounts never go negative (the database checks it too).
const divideRound = (numerator: bigint, denominator: bigint): bigint => (numerator * 2n + denominator) / (denominator * 2n)

// Prices are millionths of a US dollar per million tokens, so tokens times price over a million
// is millionths of a dollar. One rounding for the whole call, not one per token class.
export function usdMicros(price: Price, usage: Usage): bigint {
  const total =
    BigInt(usage.inputTokens) * price.inputMicros +
    BigInt(usage.outputTokens) * price.outputMicros +
    BigInt(usage.cacheReadTokens) * price.cacheReadMicros +
    BigInt(usage.cacheWriteTokens) * price.cacheWriteMicros
  return divideRound(total, MILLION)
}

// The rate is rupees per dollar in millionths.
export function inrMicros(usd: bigint, rateMicros: bigint): bigint {
  return divideRound(usd * rateMicros, MILLION)
}
```

Run: `npx vitest run apps/core/test/attempt-token.test.ts apps/core/test/money.test.ts`. Expected: PASS. (The rounding tests: 1 cache-read token is 0.2 micro, `divideRound(200000, 1000000)` is `(400000 + 1000000) / 2000000 = 0`; 3 tokens is 600000 → `(1200000 + 1000000) / 2000000 = 1`.)

- [ ] **Step 5: Write the job-creation test**

`apps/core/test/jobs-create.test.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { createJob, createRun } from '../src/jobs/service.ts'
import { AppError } from '../src/errors.ts'
import { addBrand, createStack, type Stack } from './support.ts'

let stack: Stack
let brandId: string
let definitionId: string

beforeAll(async () => {
  stack = await createStack({ withQueue: true, backlogLimit: 2 })
  brandId = await addBrand(stack, 'jobs-create')
  definitionId = await seedDefinition(stack.db)
})
afterAll(async () => {
  await stack?.close()
})

const newRun = (client: import('@mkt/db').PoolClient) =>
  createRun(client, brandId, { agent: 'test-agent', definitionVersionId: definitionId, startedByKind: 'system', startedById: null })

describe('creating a job with its cause', () => {
  it('writes the run, the job input, the control row and the queue row together', async () => {
    let jobId = ''
    await withBrand(stack.appPool, brandId, async (client) => {
      const runId = await newRun(client)
      jobId = await createJob(client, stack.jobs, brandId, {
        runId,
        jobClass: 'production',
        input: { topic: 'launch' },
        expectedResultType: 'test.echo',
      })
    })
    const input = await withBrand(stack.appPool, brandId, (c) => c.query('select class, input, run_id from app.job_input where job_id = $1', [jobId]))
    const control = await withBrand(stack.appPool, brandId, (c) => c.query('select held, cancel_requested from app.job_control where job_id = $1', [jobId]))
    const run = await withBrand(stack.appPool, brandId, (c) =>
      c.query('select started_by_kind, state from app.run where id = $1', [input.rows[0].run_id]),
    )
    expect(input.rows[0]).toMatchObject({ class: 'production', input: { topic: 'launch' } })
    expect(control.rows[0]).toEqual({ held: false, cancel_requested: false })
    expect(run.rows[0]).toMatchObject({ started_by_kind: 'system' })
    expect(await stack.jobs.queue.state('production', jobId)).toBe('created')
  })

  it('leaves no job, no input and no queue row when the business transaction rolls back', async () => {
    let jobId = ''
    await expect(
      withBrand(stack.appPool, brandId, async (client) => {
        const runId = await newRun(client)
        jobId = await createJob(client, stack.jobs, brandId, {
          runId,
          jobClass: 'interactive',
          input: {},
          expectedResultType: 'test.echo',
        })
        throw new Error('the business change failed')
      }),
    ).rejects.toThrow('the business change failed')
    expect(await stack.jobs.queue.state('interactive', jobId)).toBeNull()
    const rows = await withBrand(stack.appPool, brandId, (c) => c.query('select 1 from app.job_input where job_id = $1', [jobId]))
    expect(rows.rowCount).toBe(0)
  })

  it('refuses a production job when the class backlog is at its limit, and still accepts an interactive one', async () => {
    const make = (jobClass: 'production' | 'interactive') =>
      withBrand(stack.appPool, brandId, async (client) => {
        const runId = await newRun(client)
        return createJob(client, stack.jobs, brandId, { runId, jobClass, input: {}, expectedResultType: 'test.echo' })
      })
    // The first test already queued one production job; with a limit of 2, one more fits and the next does not.
    await make('production')
    await expect(make('production')).rejects.toMatchObject({ status: 503, code: 'queue_busy' } satisfies Partial<AppError>)
    await expect(make('interactive')).resolves.toMatch(/^[0-9a-f-]{36}$/)
  })

  it('gives every job a scheduling key that is not the brand ID', async () => {
    const { rows } = await stack.db.admin.query<{ group_id: string }>(`select group_id from pgboss.job where name = 'job-production' limit 1`)
    const brand = await stack.db.admin.query<{ schedule_key: string }>('select schedule_key from app.brand where id = $1', [brandId])
    expect(rows[0]?.group_id).toBe(brand.rows[0]?.schedule_key)
    expect(rows[0]?.group_id).not.toBe(brandId)
  })
})

void randomUUID
```

- [ ] **Step 6: Extend the test stack**

In `apps/core/test/support.ts`, add two options to `createStack`: `withQueue?: boolean` and `backlogLimit?: number` (default 2000). When `withQueue` is true: call `createQueueTestDatabase()` from `@mkt/queue/testing` instead of `createTestDatabase()`; `const queue = await openQueue(db.urlFor('queue'))`; build `jobs: JobsDeps` as `{ pool: appPool, queue, audit, workerSecret: 'worker-secret-'.padEnd(48, 'w'), attemptTokenSecret: 'attempt-secret-'.padEnd(48, 'a'), backlogLimit, now: clock, results }` where `results` is a `ResultHandlers` registry (Task 8; until then `new Map()`), pass `jobs` to `buildCore`, expose `stack.jobs` and stop the queue in `close()`. Add `@mkt/queue` to `apps/core/package.json` dependencies (`"@mkt/queue": "*"`). Default `withQueue` is false, so every existing test is unchanged.

`ResultHandlers` is declared in `apps/core/src/jobs/results.ts` in Task 8; to keep this task compiling, create that file now with only:

```ts
import type { PoolClient } from '@mkt/db'

export interface ResultContext {
  brandId: string
  jobId: string
  runId: string
  result: unknown
}
// A result type's handler writes the business effect inside the transaction the core opens, and returns
// the outcome that a repeated post will get back.
export type ResultHandler = (client: PoolClient, context: ResultContext) => Promise<unknown>
export type ResultHandlers = Map<string, ResultHandler>
```

- [ ] **Step 7: Write configuration and job creation**

`apps/core/src/config.ts`: add to the zod `schema` `QUEUE_DATABASE_URL: z.url()`, `WORKER_SECRET: z.string().min(32)`, `ATTEMPT_TOKEN_SECRET: z.string().min(32)`, `QUEUE_BACKLOG_LIMIT: z.coerce.number().int().positive().default(2000)`; add `queueDatabaseUrl`, `workerSecret`, `attemptTokenSecret`, `queueBacklogLimit` to `Config` and map them in `loadConfig`. In `loadConfig`, refuse equal secrets: if `WORKER_SECRET === ATTEMPT_TOKEN_SECRET` or either equals `AUTH_SECRET`, throw `Invalid configuration: secrets must differ` (names only, never values).

`.env.example`: add live lines `QUEUE_DATABASE_URL=postgres://mkt_queue:CHANGE_ME@127.0.0.1:54329/mkt_dev`, `WORKER_SECRET=CHANGE_ME_at_least_32_characters_long`, `ATTEMPT_TOKEN_SECRET=CHANGE_ME_another_32_characters_or_more`, `QUEUE_BACKLOG_LIMIT=2000`. Update the `Config` literal in `apps/core/test/support.ts` and the expectations in `apps/core/test/config.test.ts` (each new key present; the two secrets equal is refused; a missing one lists only its name).

`apps/core/src/jobs/service.ts` (creation part):

```ts
import type { Pool, PoolClient } from '@mkt/db'
import type { JobClass, Queue } from '@mkt/queue'
import { randomUUID } from 'node:crypto'
import type { AuditSink } from '../ports.ts'
import { AppError } from '../errors.ts'
import type { ResultHandlers } from './results.ts'

export interface JobsDeps {
  pool: Pool
  queue: Queue
  audit: AuditSink
  workerSecret: string
  attemptTokenSecret: string
  backlogLimit: number
  now: () => Date
  results: ResultHandlers
}

export interface NewRun {
  agent: string
  definitionVersionId: string
  startedByKind: 'user' | 'agent' | 'system' | 'n8n'
  startedById: string | null
}

export async function createRun(client: PoolClient, brandId: string, run: NewRun): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into app.run (brand_id, agent, definition_version_id, state, started_by_kind, started_by_id)
     values ($1, $2, $3, 'running', $4, $5) returning id`,
    [brandId, run.agent, run.definitionVersionId, run.startedByKind, run.startedById],
  )
  return rows[0]!.id
}

export interface NewJob {
  runId: string
  jobClass: JobClass
  input: unknown
  expectedResultType: string
}

// Backpressure applies to production and bulk work only (architecture 7.1): interactive and publishing
// work is never refused for a backlog.
const BACKPRESSURE: ReadonlySet<JobClass> = new Set(['production', 'bulk'])

// Runs inside the caller's withBrand transaction, so the job exists if and only if the business change does.
export async function createJob(
  client: PoolClient,
  deps: Pick<JobsDeps, 'queue' | 'backlogLimit'>,
  brandId: string,
  job: NewJob,
): Promise<string> {
  if (BACKPRESSURE.has(job.jobClass) && (await deps.queue.depth(job.jobClass)) >= deps.backlogLimit) {
    throw new AppError(503, 'queue_busy', 'Too much work is waiting. Try again shortly.')
  }
  const brand = await client.query<{ schedule_key: string }>('select schedule_key from app.brand where id = $1', [brandId])
  const scheduleKey = brand.rows[0]?.schedule_key
  if (!scheduleKey) throw new AppError(404, 'brand_not_found', 'No such brand.')
  const jobId = randomUUID()
  await client.query(
    `insert into app.job_input (job_id, brand_id, run_id, class, input, expected_result_type)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [jobId, brandId, job.runId, job.jobClass, JSON.stringify(job.input), job.expectedResultType],
  )
  await client.query('insert into app.job_control (job_id, brand_id) values ($1, $2)', [jobId, brandId])
  await deps.queue.send(client, { jobId, jobClass: job.jobClass, scheduleKey })
  return jobId
}
```

Wire `jobs?: JobsDeps` into `CoreDeps` in `core.ts` and build it in `server.ts`/`main.ts` from the config (`openQueue(config.queueDatabaseUrl)`; the core's queue connection does not supervise).

- [ ] **Step 8: Run**

Run (server): `npx vitest run apps/core`. Expected: PASS, including every existing test (the new config keys are in the test stack's `Config` literal).

- [ ] **Step 9: Commit**

```bash
git add apps/core .env.example package.json package-lock.json
git commit -m "feat(core): attempt token, cost arithmetic, and job creation in the business transaction"
```

---

### Task 6: Workers call the core: starting an attempt, and refusals that are recorded

**Files:**

- Create: `apps/core/src/access/worker-auth.ts`, `apps/core/src/routes/worker.ts`
- Modify: `apps/core/src/jobs/service.ts` (add `startAttempt`, `requireCurrentAttempt`, `readControl`), `apps/core/src/access/routes.ts` (two new access kinds), `apps/core/src/guard.ts`, `apps/core/src/api.ts`, `apps/core/src/core.ts`, `apps/core/src/audit/db-audit.ts` (no change needed: actor `null` records `system`), route-table tests
- Test: `apps/core/test/worker-attempts.test.ts`, `apps/core/test/worker-guard.test.ts`

**Interfaces:**

- Consumes: Task 5's `JobsDeps`, `verifyAttemptToken`, `signAttemptToken`; `RouteTable`; `AuditSink`.
- Produces:

```ts
// routes.ts: two more members of Access
| { kind: 'worker' }   // the worker credential only
| { kind: 'attempt' }  // the worker credential and an attempt token

// service.ts
export interface StartedAttempt {
  finished: false
  attemptId: string
  attemptNumber: number
  token: string
  input: unknown
  savedSteps: unknown[]
  expectedResultType: string
  jobClass: JobClass
}
export interface FinishedJob { finished: true; outcome: unknown }
export function startAttempt(deps: JobsDeps, jobId: string, workerId: string): Promise<StartedAttempt | FinishedJob>
// Throws AppError(403, 'attempt_refused') and records the refusal when the attempt is not the job's current one.
export function requireCurrentAttempt(client: PoolClient, deps: JobsDeps, claims: AttemptClaims): Promise<void>
export function readControl(client: PoolClient, jobId: string): Promise<{ cancelRequested: boolean; held: boolean }>

// worker-auth.ts
export function workerAuth(secret: string): RequestHandler
export function attemptAuth(deps: JobsDeps): RequestHandler
export function claimsOf(res: Response): AttemptClaims
```

Routes (all under `/api/v1`, none carries `:brandId`):

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/worker/jobs/:jobId/attempts` | `worker` | Start an attempt; returns input and token |
| GET | `/worker/jobs/:jobId/control` | `attempt` | Cancel and held flags |

- [ ] **Step 1: Write the failing test**

`apps/core/test/worker-attempts.test.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { signAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'
import { createJob, createRun } from '../src/jobs/service.ts'
import { addBrand, createStack, type Stack } from './support.ts'

let stack: Stack
let brandA: string
let brandB: string
let definitionId: string

const AUTH = (s: Stack) => `Worker ${s.jobs.workerSecret}`

async function makeJob(brandId: string, jobClass: 'production' | 'interactive' = 'production'): Promise<string> {
  return withBrand(stack.appPool, brandId, async (client) => {
    const runId = await createRun(client, brandId, { agent: 'test-agent', definitionVersionId: definitionId, startedByKind: 'system', startedById: null })
    return createJob(client, stack.jobs, brandId, { runId, jobClass, input: { for: brandId }, expectedResultType: 'test.echo' })
  })
}

// The queue's own record says a worker has claimed it. The core reads exactly this field.
async function markActive(jobId: string): Promise<void> {
  await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [jobId])
}

function call(method: string, path: string, options: { token?: string; auth?: string; body?: unknown } = {}) {
  return fetch(`${stack.server.url}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.auth === undefined ? { authorization: AUTH(stack) } : options.auth === '' ? {} : { authorization: options.auth }),
      ...(options.token ? { 'x-attempt-token': options.token } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function refusals(): Promise<{ reason: string; jobId: string }[]> {
  const { rows } = await stack.db.admin.query<{ detail: { reason: string; jobId: string } }>(
    `select detail from audit.log where action = 'worker.attempt_refused' order by at`,
  )
  return rows.map((r) => r.detail)
}

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  brandA = await addBrand(stack, 'attempts-a')
  brandB = await addBrand(stack, 'attempts-b')
  definitionId = await seedDefinition(stack.db)
})
afterAll(async () => {
  await stack?.close()
})

describe('starting an attempt', () => {
  it('gives the input and a token for a job a worker has claimed', async () => {
    const jobId = await makeJob(brandA)
    await markActive(jobId)
    const res = await call('POST', `/worker/jobs/${jobId}/attempts`, { body: { workerId: 'w1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ finished: false, attemptNumber: 1, input: { for: brandA }, savedSteps: [], expectedResultType: 'test.echo' })
    expect(body.token).toMatch(/^v1\./)
  })

  it('refuses a job the queue does not show as active', async () => {
    const jobId = await makeJob(brandA)
    const res = await call('POST', `/worker/jobs/${jobId}/attempts`, { body: { workerId: 'w1' } })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('job_not_active')
  })

  it('supersedes the earlier attempt when the job is claimed again', async () => {
    const jobId = await makeJob(brandA)
    await markActive(jobId)
    const first = await (await call('POST', `/worker/jobs/${jobId}/attempts`, { body: { workerId: 'w1' } })).json()
    const second = await (await call('POST', `/worker/jobs/${jobId}/attempts`, { body: { workerId: 'w2' } })).json()
    expect(second.attemptNumber).toBe(2)
    const states = await stack.db.admin.query<{ attempt_number: number; state: string }>(
      'select attempt_number, state from app.job_attempt where job_id = $1 order by attempt_number',
      [jobId],
    )
    expect(states.rows).toEqual([
      { attempt_number: 1, state: 'superseded' },
      { attempt_number: 2, state: 'active' },
    ])
    expect(first.attemptId).not.toBe(second.attemptId)
  })

  it('does not know a job that does not exist', async () => {
    const res = await call('POST', `/worker/jobs/${randomUUID()}/attempts`, { body: { workerId: 'w1' } })
    expect(res.status).toBe(404)
  })
})

describe('the attempt token (acceptance tests 6, 26 and 32)', () => {
  it('test 6: a token for job A cannot read job B, in the same brand or another', async () => {
    const jobA = await makeJob(brandA)
    const sameBrand = await makeJob(brandA)
    const otherBrand = await makeJob(brandB)
    for (const j of [jobA, sameBrand, otherBrand]) await markActive(j)
    const started = await (await call('POST', `/worker/jobs/${jobA}/attempts`, { body: { workerId: 'w1' } })).json()

    expect((await call('GET', `/worker/jobs/${jobA}/control`, { token: started.token })).status).toBe(200)
    for (const other of [sameBrand, otherBrand]) {
      const res = await call('GET', `/worker/jobs/${other}/control`, { token: started.token })
      expect(res.status).toBe(403)
      expect(JSON.stringify(await res.json())).not.toContain(brandB)
    }
    const logged = await refusals()
    expect(logged.filter((r) => r.reason === 'wrong_job').length).toBeGreaterThanOrEqual(2)
  })

  it('test 26: a superseded attempt is refused whatever its token says, and the refusal is recorded', async () => {
    const jobId = await makeJob(brandA)
    await markActive(jobId)
    const first = await (await call('POST', `/worker/jobs/${jobId}/attempts`, { body: { workerId: 'w1' } })).json()
    const second = await (await call('POST', `/worker/jobs/${jobId}/attempts`, { body: { workerId: 'w2' } })).json()
    expect((await call('GET', `/worker/jobs/${jobId}/control`, { token: first.token })).status).toBe(403)
    expect((await call('GET', `/worker/jobs/${jobId}/control`, { token: second.token })).status).toBe(200)
    expect((await refusals()).some((r) => r.reason === 'attempt_superseded' && r.jobId === jobId)).toBe(true)
  })

  it('test 32: an expired token, a tampered token and a token signed with the worker credential are refused', async () => {
    const jobId = await makeJob(brandA)
    await markActive(jobId)
    const started = await (await call('POST', `/worker/jobs/${jobId}/attempts`, { body: { workerId: 'w1' } })).json()
    const claims = JSON.parse(Buffer.from(started.token.split('.')[1], 'base64url').toString()) as AttemptClaims

    // Expired: the same claims, signed correctly, with a window that has closed.
    const expired = signAttemptToken(stack.jobs.attemptTokenSecret, { ...claims, issuedAt: 1, expiresAt: 2 })
    expect((await call('GET', `/worker/jobs/${jobId}/control`, { token: expired })).status).toBe(403)

    // Tampered: a field changed after signing.
    const [v, p, s] = started.token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...claims, expiresAt: claims.expiresAt + 99_999 })).toString('base64url')
    expect((await call('GET', `/worker/jobs/${jobId}/control`, { token: `${v}.${forged}.${s}` })).status).toBe(403)
    void p

    // Signed with the worker credential instead of the token secret.
    const wrongSecret = signAttemptToken(stack.jobs.workerSecret, claims)
    expect((await call('GET', `/worker/jobs/${jobId}/control`, { token: wrongSecret })).status).toBe(403)

    // No token at all.
    expect((await call('GET', `/worker/jobs/${jobId}/control`)).status).toBe(403)
    const reasons = (await refusals()).map((r) => r.reason)
    expect(reasons).toEqual(expect.arrayContaining(['expired', 'bad_signature']))
  })
})

describe('the worker credential', () => {
  it('refuses a wrong credential with 401 and no detail', async () => {
    const jobId = await makeJob(brandA)
    await markActive(jobId)
    const res = await call('POST', `/worker/jobs/${jobId}/attempts`, { auth: 'Worker not-the-secret', body: { workerId: 'w1' } })
    expect(res.status).toBe(401)
  })

  it('refuses a user session cookie on a worker route', async () => {
    const jobId = await makeJob(brandA)
    await markActive(jobId)
    const res = await call('POST', `/worker/jobs/${jobId}/attempts`, { auth: '', body: { workerId: 'w1' } })
    // No Authorization header: the ordinary origin guard applies and refuses first.
    expect(res.status).toBe(403)
  })
})
```

Add `workerSecret` and `attemptTokenSecret` to the `Stack` type as `stack.jobs.workerSecret` (already on `JobsDeps`), and `stack.server.url`: read how `startTestServer` in `apps/core/test/support.ts` exposes the base address and use that field name here.

- [ ] **Step 2: Run it to see it fail**

Run (server): `npx vitest run apps/core/test/worker-attempts.test.ts`. Expected: FAIL (404 on the routes).

- [ ] **Step 3: Add the access kinds**

In `apps/core/src/access/routes.ts`, extend `Access`:

```ts
  | { kind: 'worker' }
  | { kind: 'attempt' }
```

Change `build`'s signature to `build(deps: { auth: Auth; pool: Pool; jobs?: JobsDeps })` and add the cases:

```ts
        case 'worker':
          if (!deps.jobs) throw new Error(`${route.method} ${route.path}: worker routes need the jobs dependencies`)
          chain.push(workerAuth(deps.jobs.workerSecret))
          break
        case 'attempt':
          if (!deps.jobs) throw new Error(`${route.method} ${route.path}: worker routes need the jobs dependencies`)
          chain.push(workerAuth(deps.jobs.workerSecret), attemptAuth(deps.jobs))
          break
```

and in `add`, require that `worker` and `attempt` routes start with `/worker/` and contain no `:brandId` (they are already refused by the existing non-brand rule for `:brandId`):

```ts
    const machine = route.access.kind === 'worker' || route.access.kind === 'attempt'
    if (machine && segments[0] !== 'worker') {
      throw new Error(`${where}: a worker or attempt route must live under /worker`)
    }
    if (!machine && segments[0] === 'worker') {
      throw new Error(`${where}: only a worker or attempt route may live under /worker`)
    }
```

- [ ] **Step 4: Write the credential and token middleware**

`apps/core/src/access/worker-auth.ts`:

```ts
import { createHash, timingSafeEqual } from 'node:crypto'
import type { RequestHandler, Response } from 'express'
import { AppError } from '../errors.ts'
import { verifyAttemptToken, type AttemptClaims } from '../jobs/token.ts'
import type { JobsDeps } from '../jobs/service.ts'

// Compared as hashes so the lengths always match and nothing about the secret's length leaks.
const digest = (value: string) => createHash('sha256').update(value).digest()

export function workerAuth(secret: string): RequestHandler {
  const expected = digest(secret)
  return (req, _res, next) => {
    const header = req.headers.authorization
    const given = typeof header === 'string' && header.startsWith('Worker ') ? header.slice('Worker '.length) : ''
    if (given === '' || !timingSafeEqual(expected, digest(given))) {
      throw new AppError(401, 'unauthorized', 'A worker credential is required.')
    }
    next()
  }
}

const CLAIMS = 'attemptClaims'
export const claimsOf = (res: Response): AttemptClaims => res.locals[CLAIMS] as AttemptClaims

// Checks the token's signature and times, and that it belongs to the job in the path. Whether the attempt is
// still the current one is the service's check, made inside the transaction that acts on it.
export function attemptAuth(deps: JobsDeps): RequestHandler {
  return async (req, res, next) => {
    const jobId = String(req.params.jobId ?? '')
    const token = req.headers['x-attempt-token']
    const refuse = async (reason: string, brandId: string | null): Promise<never> => {
      await deps.audit.record({
        action: 'worker.attempt_refused',
        actor: null,
        brandId,
        subject: jobId || null,
        outcome: 'failure',
        detail: { reason, jobId },
      })
      throw new AppError(403, 'attempt_refused', 'This attempt may not do that.')
    }
    if (typeof token !== 'string' || token === '') return refuse('no_token', null)
    const checked = verifyAttemptToken(deps.attemptTokenSecret, token, Math.floor(deps.now().getTime() / 1000))
    if (!checked.ok) return refuse(checked.reason, null)
    if (checked.claims.jobId !== jobId) return refuse('wrong_job', checked.claims.brandId)
    res.locals[CLAIMS] = checked.claims
    next()
  }
}
```

`apps/core/src/guard.ts`: before the origin check, add

```ts
    // A worker call carries no cookie and no Origin; it is refused by its own credential check unless that
    // is right (plan decision 10). A browser cannot set this header on a cross-site request without a
    // preflight, and no cross-origin access is configured.
    if (req.originalUrl.startsWith('/api/v1/worker/') && typeof req.headers.authorization === 'string') {
      next()
      return
    }
```

- [ ] **Step 5: Write the attempt service and the routes**

Append to `apps/core/src/jobs/service.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { withBrand } from '@mkt/db'
import { CLASS_SETTINGS } from '@mkt/queue'
import { signAttemptToken, type AttemptClaims } from './token.ts'

export interface StartedAttempt {
  finished: false
  attemptId: string
  attemptNumber: number
  token: string
  input: unknown
  savedSteps: unknown[]
  expectedResultType: string
  jobClass: JobClass
}
export interface FinishedJob {
  finished: true
  outcome: unknown
}

export async function startAttempt(deps: JobsDeps, jobId: string, workerId: string): Promise<StartedAttempt | FinishedJob> {
  const found = await deps.pool.query<{ brand: string | null }>('select app.job_brand($1) as brand', [jobId])
  const brandId = found.rows[0]?.brand
  if (!brandId) throw new AppError(404, 'job_not_found', 'No such job.')

  return withBrand(deps.pool, brandId, async (client) => {
    const job = await client.query<{
      class: JobClass
      input: unknown
      saved_steps: unknown[]
      expected_result_type: string
      outcome: unknown
      finished_at: Date | null
    }>(
      `select class, input, saved_steps, expected_result_type, outcome, finished_at
         from app.job_input where job_id = $1 for update`,
      [jobId],
    )
    const row = job.rows[0]
    if (!row) throw new AppError(404, 'job_not_found', 'No such job.')
    // A job already finished (the worker crashed after the core accepted the result): tell it so, and the
    // worker completes the queue row. No new attempt.
    if (row.finished_at) return { finished: true as const, outcome: row.outcome }

    // The queue's own record, not the worker's word: the job must be active.
    if ((await deps.queue.state(row.class, jobId)) !== 'active') {
      throw new AppError(409, 'job_not_active', 'The queue does not show this job as claimed.')
    }

    await client.query(
      `update app.job_attempt set state = 'superseded', ended_at = now() where job_id = $1 and state = 'active'`,
      [jobId],
    )
    const next = await client.query<{ n: number }>(
      'select coalesce(max(attempt_number), 0) + 1 as n from app.job_attempt where job_id = $1',
      [jobId],
    )
    const attemptNumber = Number(next.rows[0]!.n)
    const tokenId = randomUUID()
    const created = await client.query<{ id: string }>(
      `insert into app.job_attempt (brand_id, job_id, attempt_number, worker_id, token_id)
       values ($1, $2, $3, $4, $5) returning id`,
      [brandId, jobId, attemptNumber, workerId, tokenId],
    )
    const attemptId = created.rows[0]!.id
    // A requeued job is no longer dead.
    await client.query('update app.job_control set dead_at = null, updated_at = now() where job_id = $1', [jobId])

    const issuedAt = Math.floor(deps.now().getTime() / 1000)
    const claims: AttemptClaims = {
      tokenId,
      jobId,
      brandId,
      attemptId,
      resultType: row.expected_result_type,
      issuedAt,
      expiresAt: issuedAt + CLASS_SETTINGS[row.class].expireInSeconds,
    }
    return {
      finished: false as const,
      attemptId,
      attemptNumber,
      token: signAttemptToken(deps.attemptTokenSecret, claims),
      input: row.input,
      savedSteps: row.saved_steps,
      expectedResultType: row.expected_result_type,
      jobClass: row.class,
    }
  })
}

// The attempt in the token must be the job's current one: the latest, and still active (or already
// succeeded, so a repeated result post gets its first outcome back). Anything else is refused and recorded.
export async function requireCurrentAttempt(client: PoolClient, deps: JobsDeps, claims: AttemptClaims): Promise<void> {
  const { rows } = await client.query<{ id: string; state: string }>(
    `select id, state from app.job_attempt where job_id = $1 order by attempt_number desc limit 1`,
    [claims.jobId],
  )
  const latest = rows[0]
  const current = latest?.id === claims.attemptId && (latest.state === 'active' || latest.state === 'succeeded')
  if (current) return
  const reason = latest?.id === claims.attemptId ? 'attempt_ended' : 'attempt_superseded'
  await deps.audit.record({
    action: 'worker.attempt_refused',
    actor: null,
    brandId: claims.brandId,
    subject: claims.jobId,
    outcome: 'failure',
    detail: { reason, jobId: claims.jobId, attemptId: claims.attemptId },
  })
  throw new AppError(403, 'attempt_refused', 'This attempt may not do that.')
}

export async function readControl(
  client: PoolClient,
  jobId: string,
): Promise<{ cancelRequested: boolean; held: boolean }> {
  const { rows } = await client.query<{ cancel_requested: boolean; held: boolean }>(
    'select cancel_requested, held from app.job_control where job_id = $1',
    [jobId],
  )
  const row = rows[0]
  return { cancelRequested: row?.cancel_requested ?? false, held: row?.held ?? false }
}
```

Because the refusal is recorded outside the transaction (a refused call changes nothing, so there is nothing to roll back), `audit.record` is called without a client, which goes through the audit-writer pool.

`apps/core/src/routes/worker.ts`:

```ts
import { z } from 'zod'
import { withBrand } from '@mkt/db'
import { claimsOf } from '../access/worker-auth.ts'
import type { RouteTable } from '../access/routes.ts'
import { readControl, requireCurrentAttempt, startAttempt, type JobsDeps } from '../jobs/service.ts'
import { inputOf, validate } from '../validate.ts'

const jobParams = z.strictObject({ jobId: z.uuid() })
const startBody = z.strictObject({ workerId: z.string().min(1).max(200) })

export function registerWorkerRoutes(table: RouteTable, deps: JobsDeps): void {
  table.add({
    method: 'post',
    path: '/worker/jobs/:jobId/attempts',
    access: { kind: 'worker' },
    summary: 'A worker starts an attempt on a job it has claimed and receives its input and attempt token',
    handlers: [
      validate({ params: jobParams, body: startBody }),
      async (_req, res) => {
        const { params, body } = inputOf<{ params: z.infer<typeof jobParams>; body: z.infer<typeof startBody> }>(res)
        res.json(await startAttempt(deps, params.jobId, body.workerId))
      },
    ],
  })

  table.add({
    method: 'get',
    path: '/worker/jobs/:jobId/control',
    access: { kind: 'attempt' },
    summary: 'A worker reads whether its job is cancelled or held',
    handlers: [
      validate({ params: jobParams }),
      async (_req, res) => {
        const claims = claimsOf(res)
        res.json(
          await withBrand(deps.pool, claims.brandId, async (client) => {
            await requireCurrentAttempt(client, deps, claims)
            return readControl(client, claims.jobId)
          }),
        )
      },
    ],
  })
}
```

Call `registerWorkerRoutes(table, deps.jobs)` from `createApi` when `deps.jobs` is present, and pass `jobs` to `table.build`. Check `validate`'s and `inputOf`'s actual signatures in `apps/core/src/validate.ts` and match them; the shape above follows the users routes.

- [ ] **Step 6: Update the route-table tests**

In `apps/core/test/route-table.test.ts` add (next to the existing `add` refusals; use that file's own `table` and `noop` names):

```ts
  it('keeps worker and attempt routes under /worker, and nothing else there', () => {
    const t = new RouteTable()
    expect(() => t.add({ method: 'get', path: '/jobs/:jobId', access: { kind: 'worker' }, summary: 's', handlers: [noop] })).toThrow(/under \/worker/)
    expect(() => t.add({ method: 'get', path: '/worker/x', access: { kind: 'enrolled' }, summary: 's', handlers: [noop] })).toThrow(/only a worker or attempt route/)
    expect(() => t.add({ method: 'get', path: '/worker/brands/:brandId/x', access: { kind: 'worker' }, summary: 's', handlers: [noop] })).toThrow()
    expect(() => t.add({ method: 'get', path: '/worker/x', access: { kind: 'attempt' }, summary: 's', handlers: [noop] })).not.toThrow()
  })
```

In `apps/core/test/route-declarations.test.ts` add the two Task 6 routes to the list of expected declarations, and assert that the allowlist of public routes is unchanged (the worker routes are `worker` and `attempt`, never `public`). In `apps/core/test/access-kinds.test.ts`, extend the table of kinds so the two new ones are exercised: a `worker` route answers 401 without the credential and 200 with it; an `attempt` route answers 401 without the credential and 403 with the credential and no token. `cross-brand.test.ts` walks only `/brands/:brandId` routes, so it needs no change; confirm with `npx vitest run apps/core/test/cross-brand.test.ts`.

- [ ] **Step 7: Write the guard test**

`apps/core/test/worker-guard.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createStack, type Stack } from './support.ts'

let stack: Stack
const JOB = '12345678-1234-4234-8234-123456789012'

beforeAll(async () => {
  stack = await createStack({ withQueue: true })
})
afterAll(async () => {
  await stack?.close()
})

const post = (path: string, headers: Record<string, string>) =>
  fetch(`${stack.server.url}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ workerId: 'w' }),
  })

describe('the request guard and worker calls', () => {
  it('lets a request with an Authorization header through the origin check to the credential check', async () => {
    const res = await post(`/worker/jobs/${JOB}/attempts`, { authorization: 'Worker wrong', origin: 'https://evil.example' })
    expect(res.status).toBe(401)
  })

  it('still refuses a worker route with no Authorization header at the origin check', async () => {
    const res = await post(`/worker/jobs/${JOB}/attempts`, {})
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('bad_origin')
  })

  it('does not extend the exemption to any route outside /worker', async () => {
    const res = await post('/brands', { authorization: `Worker ${stack.jobs.workerSecret}` })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 8: Run**

Run (server): `npx vitest run apps/core`. Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/core
git commit -m "feat(core): a worker starts an attempt and is checked by its token; refusals are recorded"
```

---

### Task 7: Model calls, checkpoints and cost (acceptance test 25, core half)

**Files:**

- Modify: `apps/core/src/jobs/service.ts` (add `registerModelCall`, `saveCheckpoint`, `failModelCall`), `apps/core/src/routes/worker.ts` (three routes), `apps/core/test/support.ts` (seed helpers for a price and a rate)
- Test: `apps/core/test/model-calls.test.ts`

**Interfaces:**

- Consumes: Task 5's `usdMicros`, `inrMicros`; Task 6's `requireCurrentAttempt`, `readControl`, `claimsOf`, `attemptAuth`.
- Produces:

```ts
export interface RegisterInput { step: string; requestHash: string; model: string }
export type Registered =
  | { outcome: 'send'; callId: string; possibleDuplicate: boolean }
  | { outcome: 'use_checkpoint'; output: unknown }
  | { outcome: 'cancelled' }
  | { outcome: 'held' }
export function registerModelCall(deps: JobsDeps, claims: AttemptClaims, input: RegisterInput): Promise<Registered>

export interface CheckpointInput {
  callId: string
  step: string
  output: unknown
  model: string
  providerMessageId: string
  providerRequestId: string | null
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
}
export function saveCheckpoint(deps: JobsDeps, claims: AttemptClaims, input: CheckpointInput): Promise<{ costed: boolean }>
export function failModelCall(deps: JobsDeps, claims: AttemptClaims, callId: string, error: string): Promise<void>
```

Routes (access `attempt`):

| Method | Path | Purpose |
|---|---|---|
| POST | `/worker/jobs/:jobId/model-calls` | Register a call before it is sent |
| POST | `/worker/jobs/:jobId/model-calls/:callId/checkpoint` | Save the step and cost the call, in one transaction |
| POST | `/worker/jobs/:jobId/model-calls/:callId/failure` | Mark a request that failed |

- [ ] **Step 1: Write the failing test**

`apps/core/test/model-calls.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { createJob, createRun, registerModelCall, saveCheckpoint, startAttempt, failModelCall } from '../src/jobs/service.ts'
import { verifyAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'
import { addBrand, createStack, type Stack } from './support.ts'

let stack: Stack
let brand: string
let definitionId: string

const USAGE = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }

async function startedJob(): Promise<{ jobId: string; claims: AttemptClaims }> {
  const jobId = await withBrand(stack.appPool, brand, async (client) => {
    const runId = await createRun(client, brand, { agent: 'test-agent', definitionVersionId: definitionId, startedByKind: 'system', startedById: null })
    return createJob(client, stack.jobs, brand, { runId, jobClass: 'interactive', input: {}, expectedResultType: 'test.echo' })
  })
  await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [jobId])
  const started = await startAttempt(stack.jobs, jobId, 'w1')
  if (started.finished) throw new Error('unexpected')
  const check = verifyAttemptToken(stack.jobs.attemptTokenSecret, started.token, Math.floor(stack.jobs.now().getTime() / 1000))
  if (!check.ok) throw new Error('token')
  return { jobId, claims: check.claims }
}

async function reattempt(jobId: string): Promise<AttemptClaims> {
  const started = await startAttempt(stack.jobs, jobId, 'w2')
  if (started.finished) throw new Error('unexpected')
  const check = verifyAttemptToken(stack.jobs.attemptTokenSecret, started.token, Math.floor(stack.jobs.now().getTime() / 1000))
  if (!check.ok) throw new Error('token')
  return check.claims
}

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  brand = await addBrand(stack, 'model-calls')
  definitionId = await seedDefinition(stack.db)
  await stack.db.admin.query(
    `insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, source)
     values ('test-model', current_date - 30, 4000000, 20000000, 200000, 5000000, 'test')`,
  )
  await stack.db.admin.query(`select app.record_fx_rate(current_date - 2, 83500000, 'test')`)
})
afterAll(async () => {
  await stack?.close()
})

describe('the model-call ledger and the cost ledger', () => {
  it('writes the call before it is sent, then the checkpoint and the cost in both currencies', async () => {
    const { claims } = await startedJob()
    const reg = await registerModelCall(stack.jobs, claims, { step: 'draft', requestHash: 'h1', model: 'test-model' })
    expect(reg).toMatchObject({ outcome: 'send', possibleDuplicate: false })
    if (reg.outcome !== 'send') return

    const before = await stack.db.admin.query('select status, usd_micros from app.model_call where id = $1', [reg.callId])
    expect(before.rows[0]).toEqual({ status: 'started', usd_micros: null })

    const saved = await saveCheckpoint(stack.jobs, claims, {
      callId: reg.callId, step: 'draft', output: { text: 'hello' }, model: 'test-model',
      providerMessageId: 'msg_1', providerRequestId: 'req_1', usage: USAGE,
    })
    expect(saved).toEqual({ costed: true })

    const call = await stack.db.admin.query(
      `select status, provider_message_id, input_tokens, output_tokens, charged_micros, charged_currency, usd_micros, inr_micros, fx_rate_id
         from app.model_call where id = $1`, [reg.callId])
    expect(call.rows[0]).toMatchObject({
      status: 'succeeded', provider_message_id: 'msg_1', input_tokens: 1000, output_tokens: 500,
      charged_currency: 'USD', usd_micros: '14000', inr_micros: '1169000',
    })
    const ledger = await stack.db.admin.query('select usd_micros, inr_micros, charged_micros, fx_rate_id from app.cost_ledger where model_call_id = $1', [reg.callId])
    expect(ledger.rows).toHaveLength(1)
    expect(ledger.rows[0]).toMatchObject({ usd_micros: '14000', inr_micros: '1169000', charged_micros: '14000' })
    expect(ledger.rows[0].fx_rate_id).toBe(call.rows[0].fx_rate_id)
  })

  it('uses the saved checkpoint and sends nothing for a step already done, even from a later attempt', async () => {
    const { jobId, claims } = await startedJob()
    const reg = await registerModelCall(stack.jobs, claims, { step: 'outline', requestHash: 'same', model: 'test-model' })
    if (reg.outcome !== 'send') throw new Error('unexpected')
    await saveCheckpoint(stack.jobs, claims, {
      callId: reg.callId, step: 'outline', output: { points: 3 }, model: 'test-model',
      providerMessageId: 'msg_2', providerRequestId: null, usage: USAGE,
    })
    const later = await reattempt(jobId)
    const again = await registerModelCall(stack.jobs, later, { step: 'outline', requestHash: 'same', model: 'test-model' })
    expect(again).toEqual({ outcome: 'use_checkpoint', output: { points: 3 } })
    const count = await stack.db.admin.query('select count(*)::int as n from app.model_call where job_id = $1', [jobId])
    expect(count.rows[0].n).toBe(1)
  })

  it('test 25: a call with no outcome from an earlier attempt flags the new call as a possible duplicate, and both are in the ledger', async () => {
    const { jobId, claims } = await startedJob()
    const first = await registerModelCall(stack.jobs, claims, { step: 'final', requestHash: 'x', model: 'test-model' })
    expect(first.outcome).toBe('send')
    // The worker is killed after the provider replied and before the checkpoint: nothing more is recorded.
    const later = await reattempt(jobId)
    const second = await registerModelCall(stack.jobs, later, { step: 'final', requestHash: 'x', model: 'test-model' })
    expect(second).toMatchObject({ outcome: 'send', possibleDuplicate: true })
    if (second.outcome !== 'send') return
    await saveCheckpoint(stack.jobs, later, {
      callId: second.callId, step: 'final', output: { ok: true }, model: 'test-model',
      providerMessageId: 'msg_3', providerRequestId: null, usage: USAGE,
    })
    const rows = await stack.db.admin.query(
      'select status, possible_duplicate from app.model_call where job_id = $1 order by started_at', [jobId])
    expect(rows.rows).toEqual([
      { status: 'started', possible_duplicate: false },
      { status: 'succeeded', possible_duplicate: true },
    ])
    const costs = await stack.db.admin.query('select count(*)::int as n from app.cost_ledger c join app.model_call m on m.id = c.model_call_id where m.job_id = $1', [jobId])
    expect(costs.rows[0].n).toBe(1)
  })

  it('refuses a checkpoint from an attempt that was replaced', async () => {
    const { jobId, claims } = await startedJob()
    const reg = await registerModelCall(stack.jobs, claims, { step: 's', requestHash: 'y', model: 'test-model' })
    if (reg.outcome !== 'send') throw new Error('unexpected')
    await reattempt(jobId)
    await expect(
      saveCheckpoint(stack.jobs, claims, {
        callId: reg.callId, step: 's', output: {}, model: 'test-model',
        providerMessageId: 'm', providerRequestId: null, usage: USAGE,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'attempt_refused' })
  })

  it('saves the same checkpoint twice without a second cost row', async () => {
    const { claims } = await startedJob()
    const reg = await registerModelCall(stack.jobs, claims, { step: 'twice', requestHash: 'z', model: 'test-model' })
    if (reg.outcome !== 'send') throw new Error('unexpected')
    const input = {
      callId: reg.callId, step: 'twice', output: { a: 1 }, model: 'test-model',
      providerMessageId: 'msg_4', providerRequestId: null, usage: USAGE,
    }
    await saveCheckpoint(stack.jobs, claims, input)
    await expect(saveCheckpoint(stack.jobs, claims, input)).resolves.toEqual({ costed: true })
    const n = await stack.db.admin.query('select count(*)::int as n from app.cost_ledger where model_call_id = $1', [reg.callId])
    expect(n.rows[0].n).toBe(1)
  })

  it('never loses the call or blocks the checkpoint when the model has no price', async () => {
    const { claims } = await startedJob()
    const reg = await registerModelCall(stack.jobs, claims, { step: 'noprice', requestHash: 'p', model: 'unpriced-model' })
    if (reg.outcome !== 'send') throw new Error('unexpected')
    const saved = await saveCheckpoint(stack.jobs, claims, {
      callId: reg.callId, step: 'noprice', output: { a: 1 }, model: 'unpriced-model',
      providerMessageId: 'msg_5', providerRequestId: null, usage: USAGE,
    })
    expect(saved).toEqual({ costed: false })
    const row = await stack.db.admin.query('select status, usd_micros, input_tokens from app.model_call where id = $1', [reg.callId])
    expect(row.rows[0]).toEqual({ status: 'succeeded', usd_micros: null, input_tokens: 1000 })
    const n = await stack.db.admin.query('select count(*)::int as n from app.cost_ledger where model_call_id = $1', [reg.callId])
    expect(n.rows[0].n).toBe(0)
  })

  it('uses the most recent earlier rate when today has none, and says which', async () => {
    const { claims } = await startedJob()
    const reg = await registerModelCall(stack.jobs, claims, { step: 'rate', requestHash: 'r', model: 'test-model' })
    if (reg.outcome !== 'send') throw new Error('unexpected')
    await saveCheckpoint(stack.jobs, claims, {
      callId: reg.callId, step: 'rate', output: {}, model: 'test-model',
      providerMessageId: 'msg_6', providerRequestId: null, usage: USAGE,
    })
    const row = await stack.db.admin.query(
      `select f.rate_date::text as rate_date, f.rate_micros::text as rate from app.model_call m join app.fx_rate f on f.id = m.fx_rate_id where m.id = $1`,
      [reg.callId])
    expect(row.rows[0].rate).toBe('83500000')
    expect(row.rows[0].rate_date).not.toBe(new Date().toISOString().slice(0, 10))
  })

  it('records a failed request with its error and leaves no cost', async () => {
    const { claims } = await startedJob()
    const reg = await registerModelCall(stack.jobs, claims, { step: 'fail', requestHash: 'f', model: 'test-model' })
    if (reg.outcome !== 'send') throw new Error('unexpected')
    await failModelCall(stack.jobs, claims, reg.callId, 'provider 529 overloaded')
    const row = await stack.db.admin.query('select status, error from app.model_call where id = $1', [reg.callId])
    expect(row.rows[0]).toEqual({ status: 'failed', error: 'provider 529 overloaded' })
  })

  it('answers cancelled or held before a call is sent, and writes no call row', async () => {
    const { jobId, claims } = await startedJob()
    await stack.db.admin.query('update app.job_control set held = true where job_id = $1', [jobId])
    expect(await registerModelCall(stack.jobs, claims, { step: 'h', requestHash: 'h', model: 'test-model' })).toEqual({ outcome: 'held' })
    await stack.db.admin.query('update app.job_control set held = false, cancel_requested = true where job_id = $1', [jobId])
    expect(await registerModelCall(stack.jobs, claims, { step: 'h', requestHash: 'h', model: 'test-model' })).toEqual({ outcome: 'cancelled' })
    const n = await stack.db.admin.query('select count(*)::int as n from app.model_call where job_id = $1', [jobId])
    expect(n.rows[0].n).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run (server): `npx vitest run apps/core/test/model-calls.test.ts`. Expected: FAIL, `registerModelCall` is not exported.

- [ ] **Step 3: Write the model-call service**

Append to `apps/core/src/jobs/service.ts` (imports `inrMicros`, `usdMicros` from `./money.ts` at the top of the file):

```ts
export interface RegisterInput {
  step: string
  requestHash: string
  model: string
}
export type Registered =
  | { outcome: 'send'; callId: string; possibleDuplicate: boolean }
  | { outcome: 'use_checkpoint'; output: unknown }
  | { outcome: 'cancelled' }
  | { outcome: 'held' }

interface SavedStep {
  step: string
  requestHash: string
  output: unknown
  callId: string
}

// Spec 9.5, steps 1 to 3. The row exists before the request is sent.
export async function registerModelCall(deps: JobsDeps, claims: AttemptClaims, input: RegisterInput): Promise<Registered> {
  return withBrand(deps.pool, claims.brandId, async (client) => {
    await requireCurrentAttempt(client, deps, claims)
    const job = await client.query<{ saved_steps: SavedStep[]; run_id: string }>(
      'select saved_steps, run_id from app.job_input where job_id = $1 for update',
      [claims.jobId],
    )
    const saved = job.rows[0]!.saved_steps.find((s) => s.step === input.step && s.requestHash === input.requestHash)
    if (saved) return { outcome: 'use_checkpoint' as const, output: saved.output }

    // The core hands the cancel and held flags back before every model call (spec 9.2).
    const control = await readControl(client, claims.jobId)
    if (control.cancelRequested) return { outcome: 'cancelled' as const }
    if (control.held) return { outcome: 'held' as const }

    const earlier = await client.query(
      `select 1 from app.model_call
        where job_id = $1 and step = $2 and request_hash = $3 and status = 'started' limit 1`,
      [claims.jobId, input.step, input.requestHash],
    )
    const possibleDuplicate = (earlier.rowCount ?? 0) > 0
    const created = await client.query<{ id: string }>(
      `insert into app.model_call (brand_id, run_id, job_id, attempt_id, step, request_hash, model, possible_duplicate)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [claims.brandId, job.rows[0]!.run_id, claims.jobId, claims.attemptId, input.step, input.requestHash, input.model, possibleDuplicate],
    )
    return { outcome: 'send' as const, callId: created.rows[0]!.id, possibleDuplicate }
  })
}

export interface CheckpointInput {
  callId: string
  step: string
  output: unknown
  model: string
  providerMessageId: string
  providerRequestId: string | null
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
}

// Spec 9.5, step 4: in one transaction the core saves the step, marks the call succeeded, stores the
// provider's IDs and token counts, and writes the cost. A missing price or rate never blocks it (decisions 5, 6).
export async function saveCheckpoint(deps: JobsDeps, claims: AttemptClaims, input: CheckpointInput): Promise<{ costed: boolean }> {
  return withBrand(deps.pool, claims.brandId, async (client) => {
    await requireCurrentAttempt(client, deps, claims)
    const job = await client.query<{ saved_steps: SavedStep[]; run_id: string }>(
      'select saved_steps, run_id from app.job_input where job_id = $1 for update',
      [claims.jobId],
    )
    const call = await client.query<{ status: string; request_hash: string; attempt_id: string }>(
      'select status, request_hash, attempt_id from app.model_call where id = $1 and job_id = $2',
      [input.callId, claims.jobId],
    )
    const row = call.rows[0]
    if (!row) throw new AppError(404, 'call_not_found', 'No such model call.')
    if (row.attempt_id !== claims.attemptId) throw new AppError(403, 'attempt_refused', 'This attempt may not do that.')
    if (row.status === 'succeeded') {
      const costed = await client.query('select 1 from app.cost_ledger where model_call_id = $1', [input.callId])
      return { costed: (costed.rowCount ?? 0) > 0 }
    }

    const today = deps.now().toISOString().slice(0, 10)
    const price = await client.query<{ input_micros: string; output_micros: string; cache_read_micros: string; cache_write_micros: string }>(
      `select input_micros, output_micros, cache_read_micros, cache_write_micros from app.model_price
        where model = $1 and effective_from <= $2::date order by effective_from desc limit 1`,
      [input.model, today],
    )
    const rate = await client.query<{ id: string; rate_micros: string }>(
      `select id, rate_micros from app.fx_rate
        where base_currency = 'USD' and quote_currency = 'INR' and rate_date <= $1::date
        order by rate_date desc limit 1`,
      [today],
    )
    const p = price.rows[0]
    const r = rate.rows[0]
    const costed = Boolean(p && r)
    const usd = p
      ? usdMicros(
          { inputMicros: BigInt(p.input_micros), outputMicros: BigInt(p.output_micros), cacheReadMicros: BigInt(p.cache_read_micros), cacheWriteMicros: BigInt(p.cache_write_micros) },
          input.usage,
        )
      : null
    const inr = usd !== null && r ? inrMicros(usd, BigInt(r.rate_micros)) : null

    await client.query(
      `update app.model_call set status = 'succeeded', finished_at = now(),
              provider_message_id = $2, provider_request_id = $3,
              input_tokens = $4, output_tokens = $5, cache_read_tokens = $6, cache_write_tokens = $7,
              charged_micros = $8, charged_currency = $9, usd_micros = $10, inr_micros = $11, fx_rate_id = $12
        where id = $1`,
      [
        input.callId, input.providerMessageId, input.providerRequestId,
        input.usage.inputTokens, input.usage.outputTokens, input.usage.cacheReadTokens, input.usage.cacheWriteTokens,
        costed ? usd!.toString() : null, costed ? 'USD' : null,
        costed ? usd!.toString() : null, costed ? inr!.toString() : null, costed ? r!.id : null,
      ],
    )
    if (costed) {
      const run = await client.query<{ agent: string }>('select agent from app.run where id = $1', [job.rows[0]!.run_id])
      await client.query(
        `insert into app.cost_ledger (brand_id, run_id, agent, model_call_id, charged_micros, charged_currency, usd_micros, inr_micros, fx_rate_id)
         values ($1, $2, $3, $4, $5, 'USD', $5, $6, $7)`,
        [claims.brandId, job.rows[0]!.run_id, run.rows[0]!.agent, input.callId, usd!.toString(), inr!.toString(), r!.id],
      )
    }
    const steps: SavedStep[] = [
      ...job.rows[0]!.saved_steps.filter((s) => !(s.step === input.step && s.requestHash === row.request_hash)),
      { step: input.step, requestHash: row.request_hash, output: input.output, callId: input.callId },
    ]
    await client.query('update app.job_input set saved_steps = $2::jsonb where job_id = $1', [claims.jobId, JSON.stringify(steps)])
    return { costed }
  })
}

export async function failModelCall(deps: JobsDeps, claims: AttemptClaims, callId: string, error: string): Promise<void> {
  await withBrand(deps.pool, claims.brandId, async (client) => {
    await requireCurrentAttempt(client, deps, claims)
    await client.query(
      `update app.model_call set status = 'failed', error = $3, finished_at = now()
        where id = $1 and job_id = $2 and status = 'started'`,
      [callId, claims.jobId, error.slice(0, 2000)],
    )
  })
}
```

Note on a succeeded call's `charged_micros`: it is the amount as charged in the call's own currency. Model usage is charged in US dollars, so it equals `usd_micros` (database schema 7.8).

- [ ] **Step 4: Add the three routes**

In `apps/core/src/routes/worker.ts`, add (same `validate` / `inputOf` style as Task 6):

```ts
const registerBody = z.strictObject({
  step: z.string().min(1).max(200),
  requestHash: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
})
const checkpointBody = z.strictObject({
  step: z.string().min(1).max(200),
  output: z.unknown(),
  model: z.string().min(1).max(200),
  providerMessageId: z.string().min(1).max(200),
  providerRequestId: z.string().max(200).nullable(),
  usage: z.strictObject({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    cacheReadTokens: z.number().int().min(0),
    cacheWriteTokens: z.number().int().min(0),
  }),
})
const failureBody = z.strictObject({ error: z.string().min(1).max(2000) })
const callParams = z.strictObject({ jobId: z.uuid(), callId: z.uuid() })
```

Declare `POST /worker/jobs/:jobId/model-calls` (body `registerBody`, answers `registerModelCall`), `POST /worker/jobs/:jobId/model-calls/:callId/checkpoint` (body `checkpointBody`, answers `saveCheckpoint`; `callId` from the path) and `POST /worker/jobs/:jobId/model-calls/:callId/failure` (body `failureBody`, answers 204), each `access: { kind: 'attempt' }` with `claimsOf(res)`. Raise the JSON limit for this one route family if a step's output can exceed the global 100 kB: add `express.json({ limit: '1mb' })` before `validate` on the checkpoint route only.

- [ ] **Step 5: Seed helpers**

Nothing new is needed beyond the SQL in `beforeAll` above; if a second test file needs it, move the two inserts into `apps/core/test/support.ts` as `seedPrice(stack, model)` and `seedRate(stack, daysAgo)`.

- [ ] **Step 6: Run**

Run (server): `npx vitest run apps/core`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/core
git commit -m "feat(core): register a model call before it is sent, checkpoint it, and cost it in both currencies"
```

---

### Task 8: Results, control, and the run's state (acceptance tests 26 and 27)

**Files:**

- Modify: `apps/core/src/jobs/service.ts` (add `postResult`), `apps/core/src/jobs/results.ts` (nothing new; used here), `apps/core/src/routes/worker.ts` (one route), `apps/core/test/support.ts` (a `test.echo` handler)
- Test: `apps/core/test/job-results.test.ts`

**Interfaces:**

- Consumes: `ResultHandlers` (Task 5), `requireCurrentAttempt`, `readControl`.
- Produces:

```ts
export interface PostedResult { type: string; result: unknown }
export type ResultAnswer =
  | { status: 'applied'; outcome: unknown }
  | { status: 'repeated'; outcome: unknown }
  | { status: 'held' }
export function postResult(deps: JobsDeps, claims: AttemptClaims, posted: PostedResult): Promise<ResultAnswer>
```

Route: `POST /worker/jobs/:jobId/result`, access `attempt`, body `{ type, result }`.

- [ ] **Step 1: Write the failing test**

`apps/core/test/job-results.test.ts`:

```ts
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { createJob, createRun, postResult, startAttempt } from '../src/jobs/service.ts'
import { verifyAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'
import { addBrand, createStack, type Stack } from './support.ts'

let stack: Stack
let brand: string
let definitionId: string
let applied = 0

async function startedJob(): Promise<{ jobId: string; runId: string; claims: AttemptClaims }> {
  let runId = ''
  const jobId = await withBrand(stack.appPool, brand, async (client) => {
    runId = await createRun(client, brand, { agent: 'test-agent', definitionVersionId: definitionId, startedByKind: 'system', startedById: null })
    return createJob(client, stack.jobs, brand, { runId, jobClass: 'interactive', input: {}, expectedResultType: 'test.echo' })
  })
  await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [jobId])
  const started = await startAttempt(stack.jobs, jobId, 'w1')
  if (started.finished) throw new Error('unexpected')
  const check = verifyAttemptToken(stack.jobs.attemptTokenSecret, started.token, Math.floor(stack.jobs.now().getTime() / 1000))
  if (!check.ok) throw new Error('token')
  return { jobId, runId, claims: check.claims }
}

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  brand = await addBrand(stack, 'results')
  definitionId = await seedDefinition(stack.db)
  // A result type for the tests: counts how many times a result is applied and returns a small outcome.
  stack.jobs.results.set('test.echo', async (_client, ctx) => {
    applied += 1
    return { echoed: ctx.result, jobId: ctx.jobId }
  })
})
afterAll(async () => {
  await stack?.close()
})

describe('posting a result', () => {
  it('applies a result once, stores its hash and outcome, and finishes the job and the run', async () => {
    const before = applied
    const { jobId, runId, claims } = await startedJob()
    const answer = await postResult(stack.jobs, claims, { type: 'test.echo', result: { text: 'hi' } })
    expect(answer).toMatchObject({ status: 'applied', outcome: { echoed: { text: 'hi' }, jobId } })
    expect(applied).toBe(before + 1)
    const job = await stack.db.admin.query('select result_type, result_hash, finished_at from app.job_input where job_id = $1', [jobId])
    expect(job.rows[0].result_type).toBe('test.echo')
    expect(job.rows[0].result_hash).toBe(
      'sha256:' + createHash('sha256').update(JSON.stringify({ type: 'test.echo', result: { text: 'hi' } })).digest('hex'),
    )
    expect(job.rows[0].finished_at).not.toBeNull()
    const run = await stack.db.admin.query('select state, finished_at from app.run where id = $1', [runId])
    expect(run.rows[0].state).toBe('succeeded')
  })

  it('test 27: the same result again returns the first outcome and applies nothing', async () => {
    const { claims } = await startedJob()
    const first = await postResult(stack.jobs, claims, { type: 'test.echo', result: { n: 1 } })
    const before = applied
    const second = await postResult(stack.jobs, claims, { type: 'test.echo', result: { n: 1 } })
    expect(second).toEqual({ status: 'repeated', outcome: (first as { outcome: unknown }).outcome })
    expect(applied).toBe(before)
  })

  it('test 27: a different result for a finished job is refused', async () => {
    const { claims } = await startedJob()
    await postResult(stack.jobs, claims, { type: 'test.echo', result: { n: 1 } })
    const before = applied
    await expect(postResult(stack.jobs, claims, { type: 'test.echo', result: { n: 2 } })).rejects.toMatchObject({
      status: 409,
      code: 'result_differs',
    })
    expect(applied).toBe(before)
  })

  it('refuses a result of a type other than the token allows, and a type with no handler', async () => {
    const { claims } = await startedJob()
    await expect(postResult(stack.jobs, claims, { type: 'something.else', result: {} })).rejects.toMatchObject({ status: 422, code: 'wrong_result_type' })
    stack.jobs.results.delete('test.echo')
    await expect(postResult(stack.jobs, claims, { type: 'test.echo', result: {} })).rejects.toMatchObject({ status: 422, code: 'no_result_handler' })
    stack.jobs.results.set('test.echo', async (_c, ctx) => ({ echoed: ctx.result, jobId: ctx.jobId }))
  })

  it('test 26: a result from an attempt that lost its lease is refused and recorded, and the new attempt\'s result is applied', async () => {
    const { jobId, claims: old } = await startedJob()
    const started = await startAttempt(stack.jobs, jobId, 'w2')
    if (started.finished) throw new Error('unexpected')
    const check = verifyAttemptToken(stack.jobs.attemptTokenSecret, started.token, Math.floor(stack.jobs.now().getTime() / 1000))
    if (!check.ok) throw new Error('token')

    await expect(postResult(stack.jobs, old, { type: 'test.echo', result: { from: 'old' } })).rejects.toMatchObject({ status: 403, code: 'attempt_refused' })
    const logged = await stack.db.admin.query(`select detail from audit.log where action = 'worker.attempt_refused' and detail->>'jobId' = $1`, [jobId])
    expect(logged.rowCount).toBeGreaterThanOrEqual(1)

    const answer = await postResult(stack.jobs, check.claims, { type: 'test.echo', result: { from: 'new' } })
    expect(answer).toMatchObject({ status: 'applied', outcome: { echoed: { from: 'new' } } })
  })

  it('stores a result posted while the job is held, applies nothing, and leaves the job unfinished', async () => {
    const { jobId, claims } = await startedJob()
    await stack.db.admin.query('update app.job_control set held = true where job_id = $1', [jobId])
    const before = applied
    expect(await postResult(stack.jobs, claims, { type: 'test.echo', result: { held: true } })).toEqual({ status: 'held' })
    expect(applied).toBe(before)
    const job = await stack.db.admin.query('select held_result, finished_at from app.job_input where job_id = $1', [jobId])
    expect(job.rows[0]).toMatchObject({ held_result: { type: 'test.echo', result: { held: true } }, finished_at: null })
  })

  it('refuses a result for a job whose cancel was requested', async () => {
    const { jobId, claims } = await startedJob()
    await stack.db.admin.query('update app.job_control set cancel_requested = true where job_id = $1', [jobId])
    await expect(postResult(stack.jobs, claims, { type: 'test.echo', result: {} })).rejects.toMatchObject({ status: 409, code: 'job_cancelled' })
  })

  it('rolls the whole result back when the handler throws', async () => {
    const { jobId, claims } = await startedJob()
    stack.jobs.results.set('test.echo', async () => {
      throw new Error('handler failed')
    })
    await expect(postResult(stack.jobs, claims, { type: 'test.echo', result: {} })).rejects.toThrow('handler failed')
    const job = await stack.db.admin.query('select result_hash, finished_at from app.job_input where job_id = $1', [jobId])
    expect(job.rows[0]).toEqual({ result_hash: null, finished_at: null })
    stack.jobs.results.set('test.echo', async (_c, ctx) => ({ echoed: ctx.result, jobId: ctx.jobId }))
  })
})
```

Add `results` to the `JobsDeps` the test reads (`stack.jobs.results` is the `ResultHandlers` map, a `Map`, so `set` and `delete` are available).

- [ ] **Step 2: Run it to see it fail**

Run (server): `npx vitest run apps/core/test/job-results.test.ts`. Expected: FAIL, `postResult` is not exported.

- [ ] **Step 3: Write `postResult`**

Append to `apps/core/src/jobs/service.ts` (`createHash` from `node:crypto` at the top):

```ts
export interface PostedResult {
  type: string
  result: unknown
}
export type ResultAnswer =
  | { status: 'applied'; outcome: unknown }
  | { status: 'repeated'; outcome: unknown }
  | { status: 'held' }

const resultHash = (posted: PostedResult): string =>
  `sha256:${createHash('sha256').update(JSON.stringify({ type: posted.type, result: posted.result })).digest('hex')}`

// Spec 9.4. One transaction: the result, its business effect, the job's end and the run's state commit
// together, or none do. The job row is locked so two posts cannot both apply.
export async function postResult(deps: JobsDeps, claims: AttemptClaims, posted: PostedResult): Promise<ResultAnswer> {
  return withBrand(deps.pool, claims.brandId, async (client) => {
    await requireCurrentAttempt(client, deps, claims)
    const found = await client.query<{
      run_id: string
      expected_result_type: string
      result_hash: string | null
      outcome: unknown
      finished_at: Date | null
    }>(
      `select run_id, expected_result_type, result_hash, outcome, finished_at
         from app.job_input where job_id = $1 for update`,
      [claims.jobId],
    )
    const job = found.rows[0]!
    const hash = resultHash(posted)

    if (job.finished_at) {
      if (job.result_hash === hash) return { status: 'repeated' as const, outcome: job.outcome }
      throw new AppError(409, 'result_differs', 'This job already has a different result.')
    }
    if (posted.type !== job.expected_result_type || posted.type !== claims.resultType) {
      throw new AppError(422, 'wrong_result_type', 'This job may not post a result of that type.')
    }
    const control = await readControl(client, claims.jobId)
    if (control.cancelRequested) throw new AppError(409, 'job_cancelled', 'This job was cancelled.')
    if (control.held) {
      // Kept, not applied: no content version, no further job, no notification until release (spec 9.4).
      await client.query('update app.job_input set held_result = $2::jsonb where job_id = $1', [claims.jobId, JSON.stringify(posted)])
      return { status: 'held' as const }
    }
    const handler = deps.results.get(posted.type)
    if (!handler) throw new AppError(422, 'no_result_handler', 'Nothing accepts a result of that type.')

    const outcome = await handler(client, { brandId: claims.brandId, jobId: claims.jobId, runId: job.run_id, result: posted.result })
    await client.query(
      `update app.job_input set result_type = $2, result_hash = $3, outcome = $4::jsonb, finished_at = now()
        where job_id = $1`,
      [claims.jobId, posted.type, hash, JSON.stringify(outcome ?? null)],
    )
    await client.query(`update app.job_attempt set state = 'succeeded', ended_at = now() where id = $1`, [claims.attemptId])
    // The run succeeds when none of its jobs is left unfinished.
    await client.query(
      `update app.run set state = 'succeeded', finished_at = now()
        where id = $1 and not exists (select 1 from app.job_input where run_id = $1 and finished_at is null)`,
      [job.run_id],
    )
    return { status: 'applied' as const, outcome: outcome ?? null }
  })
}
```

Add the route to `apps/core/src/routes/worker.ts`: `POST /worker/jobs/:jobId/result`, `access: { kind: 'attempt' }`, body `z.strictObject({ type: z.string().min(1).max(100), result: z.unknown() })`, answers `postResult(...)`; a `held` answer is HTTP 202, applied and repeated are 200.

- [ ] **Step 4: Run**

Run (server): `npx vitest run apps/core`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core
git commit -m "feat(core): post a result once, repeat it safely, hold it when the job is held"
```

---

### Task 9: The worker process, and what happens when it is killed (acceptance tests 24 and 25)

**Files:**

- Create: `apps/worker/package.json`, `apps/worker/src/config.ts`, `apps/worker/src/core-client.ts`, `apps/worker/src/model.ts`, `apps/worker/src/anthropic.ts`, `apps/worker/src/standin.ts`, `apps/worker/src/runner.ts`, `apps/worker/src/main.ts`
- Modify: `packages/queue/src/queue.ts` (supervision interval option), `packages/stack-check/package.json` is left as it is (the SDK stays pinned there too; `versions.test.ts` pins the same version for both)
- Test: `apps/worker/test/runner.test.ts`, `apps/worker/test/crash.test.ts`, `apps/worker/test/child.ts`

**Interfaces:**

- Consumes: `openQueue`, `Queue`, `JobClass`, `JOB_CLASSES` from `@mkt/queue`; the worker routes of Tasks 6 to 8 over HTTP.
- Produces:

```ts
// model.ts
export interface ModelRequest { model: string; system?: string; messages: { role: 'user' | 'assistant'; content: string }[]; maxTokens: number; effort?: 'low' | 'medium' | 'high' }
export interface ModelUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export interface ModelReply { text: string; messageId: string; requestId: string | null; usage: ModelUsage }
export interface ModelClient { send(request: ModelRequest): Promise<ModelReply> }

// core-client.ts
export interface CoreClient {
  startAttempt(jobId: string, workerId: string): Promise<StartedAttempt | { finished: true; outcome: unknown }>
  control(jobId: string, token: string): Promise<{ cancelRequested: boolean; held: boolean }>
  registerModelCall(jobId: string, token: string, input: { step: string; requestHash: string; model: string }): Promise<Registered>
  checkpoint(jobId: string, token: string, callId: string, input: CheckpointBody): Promise<{ costed: boolean }>
  failCall(jobId: string, token: string, callId: string, error: string): Promise<void>
  postResult(jobId: string, token: string, posted: { type: string; result: unknown }): Promise<{ status: 'applied' | 'repeated' | 'held' }>
  // Worker-level calls (no attempt token): the dead-letter watcher and the reconciliation timer (task 10).
  jobDead(jobId: string): Promise<void>
  reconcile(): Promise<{ marked: number }>
}
export function httpCoreClient(baseUrl: string, workerSecret: string): CoreClient

// runner.ts
export interface JobContext {
  jobId: string
  jobClass: JobClass
  input: unknown
  // One model call as a step: checkpointed, never sent again once saved, stopped by cancel or hold.
  modelStep(step: string, request: ModelRequest): Promise<{ text: string }>
  // Called between steps: throws JobStopped when the job was cancelled or held.
  checkStop(): Promise<void>
}
export type JobHandler = (ctx: JobContext) => Promise<{ type: string; result: unknown }>
export class JobStopped extends Error { readonly why: 'cancelled' | 'held' }
export function runJob(deps: { core: CoreClient; model: ModelClient; handlers: Record<string, JobHandler>; workerId: string }, job: { id: string; jobClass: JobClass }): Promise<void>

// main.ts
export interface WorkerOptions { core: CoreClient; model: ModelClient; handlers: Record<string, JobHandler>; queueUrl: string; workerId: string; classes: JobClass[]; processesPerClass: number; superviseIntervalSeconds?: number }
export function startWorker(options: WorkerOptions): Promise<{ stop(): Promise<void> }>
```

- [ ] **Step 1: Write the runner test (fake core, fake model)**

`apps/worker/test/runner.test.ts`:

```ts
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CoreClient } from '../src/core-client.ts'
import type { ModelClient, ModelRequest } from '../src/model.ts'
import { JobStopped, runJob, type JobHandler } from '../src/runner.ts'

const hashOf = (r: ModelRequest) => createHash('sha256').update(JSON.stringify(r)).digest('hex')

function fakeCore(overrides: Partial<CoreClient> = {}): CoreClient & { posted: unknown[]; calls: string[] } {
  const posted: unknown[] = []
  const calls: string[] = []
  const core: CoreClient = {
    async startAttempt() {
      return { finished: false, attemptId: 'a', attemptNumber: 1, token: 'tok', input: { x: 1 }, savedSteps: [], expectedResultType: 'test.echo', jobClass: 'interactive' }
    },
    async control() {
      return { cancelRequested: false, held: false }
    },
    async registerModelCall(_j, _t, input) {
      calls.push(`register:${input.step}`)
      return { outcome: 'send', callId: `call-${input.step}`, possibleDuplicate: false }
    },
    async checkpoint(_j, _t, callId) {
      calls.push(`checkpoint:${callId}`)
      return { costed: true }
    },
    async failCall(_j, _t, callId) {
      calls.push(`fail:${callId}`)
    },
    async postResult(_j, _t, p) {
      posted.push(p)
      return { status: 'applied' }
    },
    async jobDead() {},
    async reconcile() {
      return { marked: 0 }
    },
    ...overrides,
  }
  return Object.assign(core, { posted, calls })
}

const model: ModelClient & { sent: ModelRequest[] } = {
  sent: [],
  async send(request) {
    this.sent.push(request)
    return { text: `reply to ${request.messages[0]!.content}`, messageId: 'msg', requestId: 'req', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  },
}

const handler: JobHandler = async (ctx) => {
  const a = await ctx.modelStep('one', { model: 'm', messages: [{ role: 'user', content: 'one' }], maxTokens: 10 })
  await ctx.checkStop()
  const b = await ctx.modelStep('two', { model: 'm', messages: [{ role: 'user', content: 'two' }], maxTokens: 10 })
  return { type: 'test.echo', result: [a.text, b.text] }
}
const deps = (core: CoreClient) => ({ core, model, handlers: { 'test.echo': handler }, workerId: 'w' })

describe('running a job', () => {
  it('runs each step as a registered, sent and checkpointed model call, then posts the result', async () => {
    model.sent.length = 0
    const core = fakeCore()
    await runJob(deps(core), { id: 'j1', jobClass: 'interactive' })
    expect(core.calls).toEqual(['register:one', 'checkpoint:call-one', 'register:two', 'checkpoint:call-two'])
    expect(core.posted).toEqual([{ type: 'test.echo', result: ['reply to one', 'reply to two'] }])
  })

  it('sends nothing for a step the core says is already saved', async () => {
    model.sent.length = 0
    const core = fakeCore({
      async registerModelCall(_j, _t, input) {
        return input.step === 'one' ? { outcome: 'use_checkpoint', output: { text: 'saved one' } } : { outcome: 'send', callId: 'c2', possibleDuplicate: false }
      },
    })
    await runJob(deps(core), { id: 'j2', jobClass: 'interactive' })
    expect(model.sent.map((r) => r.messages[0]!.content)).toEqual(['two'])
    expect(core.posted).toEqual([{ type: 'test.echo', result: ['saved one', 'reply to two'] }])
  })

  it('stops quietly, posting nothing, when the core says cancelled or held', async () => {
    for (const outcome of ['cancelled', 'held'] as const) {
      model.sent.length = 0
      const core = fakeCore({ async registerModelCall() { return { outcome } } })
      await expect(runJob(deps(core), { id: 'j3', jobClass: 'interactive' })).resolves.toBeUndefined()
      expect(model.sent).toHaveLength(0)
      expect(core.posted).toHaveLength(0)
    }
  })

  it('stops between steps when the control flags say so', async () => {
    model.sent.length = 0
    const core = fakeCore({ async control() { return { cancelRequested: true, held: false } } })
    await runJob(deps(core), { id: 'j4', jobClass: 'interactive' })
    expect(model.sent.map((r) => r.messages[0]!.content)).toEqual(['one'])
    expect(core.posted).toHaveLength(0)
  })

  it('marks a failed request and lets the failure reach the queue, so the job is retried', async () => {
    const core = fakeCore()
    const failing: ModelClient = { async send() { throw new Error('provider overloaded') } }
    await expect(runJob({ ...deps(core), model: failing }, { id: 'j5', jobClass: 'interactive' })).rejects.toThrow('provider overloaded')
    expect(core.calls).toContain('fail:call-one')
  })

  it('does nothing for a job the core says is already finished', async () => {
    const core = fakeCore({ async startAttempt() { return { finished: true, outcome: {} } } })
    await runJob(deps(core), { id: 'j6', jobClass: 'interactive' })
    expect(core.calls).toEqual([])
  })

  it('fails a job whose result type has no handler', async () => {
    const core = fakeCore({ async startAttempt() { return { finished: false, attemptId: 'a', attemptNumber: 1, token: 't', input: {}, savedSteps: [], expectedResultType: 'unknown.type', jobClass: 'interactive' } } })
    await expect(runJob(deps(core), { id: 'j7', jobClass: 'interactive' })).rejects.toThrow(/no handler for unknown.type/)
  })
})

void hashOf
void JobStopped
```

- [ ] **Step 2: Run it to see it fail**

Run (server): `npx vitest run apps/worker/test/runner.test.ts`. Expected: FAIL, modules not found.

- [ ] **Step 3: Write the worker package**

`apps/worker/package.json`:

```json
{
  "name": "@mkt/worker",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": { "start": "node src/main.ts" },
  "dependencies": {
    "@anthropic-ai/sdk": "0.124.0",
    "@mkt/queue": "*",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "@mkt/test-support": "*"
  }
}
```

`apps/worker/src/model.ts`:

```ts
export interface ModelRequest {
  model: string
  system?: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  maxTokens: number
  effort?: 'low' | 'medium' | 'high'
}
export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}
export interface ModelReply {
  text: string
  messageId: string
  requestId: string | null
  usage: ModelUsage
}
export interface ModelClient {
  send(request: ModelRequest): Promise<ModelReply>
}
```

`apps/worker/src/anthropic.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk'
import type { ModelClient, ModelReply, ModelRequest } from './model.ts'

// The only place the provider key is used. Streaming is not needed for the step sizes in phase 1; long
// outputs (architecture 14) will switch this one call to a stream without changing the port.
export function anthropicModel(apiKey: string): ModelClient {
  const client = new Anthropic({ apiKey })
  return {
    async send(request: ModelRequest): Promise<ModelReply> {
      const response = await client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        ...(request.system ? { system: request.system } : {}),
        ...(request.effort ? { output_config: { effort: request.effort } } : {}),
        messages: request.messages,
      })
      const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
      return {
        text,
        messageId: response.id,
        requestId: (response as { _request_id?: string | null })._request_id ?? null,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
      }
    },
  }
}
```

`apps/worker/src/core-client.ts`:

```ts
import type { JobClass } from '@mkt/queue'

export interface StartedAttempt {
  finished: false
  attemptId: string
  attemptNumber: number
  token: string
  input: unknown
  savedSteps: unknown[]
  expectedResultType: string
  jobClass: JobClass
}
export type Registered =
  | { outcome: 'send'; callId: string; possibleDuplicate: boolean }
  | { outcome: 'use_checkpoint'; output: { text: string } | unknown }
  | { outcome: 'cancelled' }
  | { outcome: 'held' }
export interface CheckpointBody {
  step: string
  output: unknown
  model: string
  providerMessageId: string
  providerRequestId: string | null
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
}
export interface CoreClient {
  startAttempt(jobId: string, workerId: string): Promise<StartedAttempt | { finished: true; outcome: unknown }>
  control(jobId: string, token: string): Promise<{ cancelRequested: boolean; held: boolean }>
  registerModelCall(jobId: string, token: string, input: { step: string; requestHash: string; model: string }): Promise<Registered>
  checkpoint(jobId: string, token: string, callId: string, input: CheckpointBody): Promise<{ costed: boolean }>
  failCall(jobId: string, token: string, callId: string, error: string): Promise<void>
  postResult(jobId: string, token: string, posted: { type: string; result: unknown }): Promise<{ status: 'applied' | 'repeated' | 'held' }>
  jobDead(jobId: string): Promise<void>
  reconcile(): Promise<{ marked: number }>
}

export class CoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function httpCoreClient(baseUrl: string, workerSecret: string): CoreClient {
  async function call<T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Worker ${workerSecret}`,
        ...(token ? { 'x-attempt-token': token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.status === 204) return undefined as T
    const json = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
    if (!response.ok) throw new CoreError(response.status, json.error?.code ?? 'error', json.error?.message ?? response.statusText)
    return json as T
  }
  return {
    startAttempt: (jobId, workerId) => call('POST', `/worker/jobs/${jobId}/attempts`, null, { workerId }),
    control: (jobId, token) => call('GET', `/worker/jobs/${jobId}/control`, token),
    registerModelCall: (jobId, token, input) => call('POST', `/worker/jobs/${jobId}/model-calls`, token, input),
    checkpoint: (jobId, token, callId, input) => call('POST', `/worker/jobs/${jobId}/model-calls/${callId}/checkpoint`, token, input),
    failCall: (jobId, token, callId, error) => call('POST', `/worker/jobs/${jobId}/model-calls/${callId}/failure`, token, { error }),
    postResult: (jobId, token, posted) => call('POST', `/worker/jobs/${jobId}/result`, token, posted),
    jobDead: (jobId) => call('POST', `/worker/jobs/${jobId}/dead`, null),
    reconcile: () => call('POST', '/worker/reconcile', null),
  }
}
```

`apps/worker/src/runner.ts`:

```ts
import { createHash } from 'node:crypto'
import type { JobClass } from '@mkt/queue'
import type { CoreClient } from './core-client.ts'
import type { ModelClient, ModelRequest } from './model.ts'

export class JobStopped extends Error {
  constructor(readonly why: 'cancelled' | 'held') {
    super(`job ${why}`)
  }
}

export interface JobContext {
  jobId: string
  jobClass: JobClass
  input: unknown
  modelStep(step: string, request: ModelRequest): Promise<{ text: string }>
  checkStop(): Promise<void>
}
export type JobHandler = (ctx: JobContext) => Promise<{ type: string; result: unknown }>

export interface RunnerDeps {
  core: CoreClient
  model: ModelClient
  handlers: Record<string, JobHandler>
  workerId: string
}

// The hash covers everything that decides the provider's answer, in a fixed key order, so the same
// step with the same request is recognised after a crash (spec 9.5).
function requestHash(request: ModelRequest): string {
  const ordered = {
    model: request.model,
    system: request.system ?? null,
    messages: request.messages,
    maxTokens: request.maxTokens,
    effort: request.effort ?? null,
  }
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

export async function runJob(deps: RunnerDeps, job: { id: string; jobClass: JobClass }): Promise<void> {
  const started = await deps.core.startAttempt(job.id, deps.workerId)
  // Finished already (the core accepted the result and the worker died before completing the queue row).
  if (started.finished) return
  const handler = deps.handlers[started.expectedResultType]
  if (!handler) throw new Error(`no handler for ${started.expectedResultType}`)

  const ctx: JobContext = {
    jobId: job.id,
    jobClass: job.jobClass,
    input: started.input,
    async checkStop() {
      const control = await deps.core.control(job.id, started.token)
      if (control.cancelRequested) throw new JobStopped('cancelled')
      if (control.held) throw new JobStopped('held')
    },
    async modelStep(step, request) {
      const registered = await deps.core.registerModelCall(job.id, started.token, {
        step,
        requestHash: requestHash(request),
        model: request.model,
      })
      if (registered.outcome === 'use_checkpoint') return registered.output as { text: string }
      if (registered.outcome === 'cancelled' || registered.outcome === 'held') throw new JobStopped(registered.outcome)

      let reply
      try {
        reply = await deps.model.send(request)
      } catch (error) {
        await deps.core.failCall(job.id, started.token, registered.callId, error instanceof Error ? error.message : String(error))
        throw error
      }
      const output = { text: reply.text }
      await deps.core.checkpoint(job.id, started.token, registered.callId, {
        step,
        output,
        model: request.model,
        providerMessageId: reply.messageId,
        providerRequestId: reply.requestId,
        usage: reply.usage,
      })
      return output
    },
  }

  try {
    const outcome = await handler(ctx)
    await deps.core.postResult(job.id, started.token, outcome)
  } catch (error) {
    // A cancelled or held job ends here without a retry: the core already knows.
    if (error instanceof JobStopped) return
    throw error
  }
}
```

Run: `npx vitest run apps/worker/test/runner.test.ts`. Expected: PASS.

- [ ] **Step 4: Write the stand-in model and the entry point**

`apps/worker/src/standin.ts`:

```ts
import { appendFile } from 'node:fs/promises'
import type { ModelClient } from './model.ts'

// Test only (the entry point refuses it outside NODE_ENV=test). Answers deterministically, logs each request
// it is sent, and can kill its own process at a chosen step to imitate a crash.
export interface StandInOptions {
  logFile: string
  crashBeforeReplyOn?: string
  crashAfterReplyOn?: string
  delayMs?: number
}

export function standInModel(options: StandInOptions): ModelClient {
  return {
    async send(request) {
      const step = request.messages[request.messages.length - 1]!.content
      await appendFile(options.logFile, `sent ${step}\n`)
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      if (options.crashBeforeReplyOn === step) process.kill(process.pid, 'SIGKILL')
      const reply = {
        text: `reply:${step}`,
        messageId: `msg_${step}_${Math.random().toString(36).slice(2, 10)}`,
        requestId: null,
        usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      // The provider has answered and been charged; the process dies before it can say so.
      if (options.crashAfterReplyOn === step) process.kill(process.pid, 'SIGKILL')
      return reply
    },
  }
}
```

`apps/worker/src/config.ts`:

```ts
import { hostname } from 'node:os'
import { JOB_CLASSES, type JobClass } from '@mkt/queue'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CORE_URL: z.url(),
  WORKER_SECRET: z.string().min(32),
  QUEUE_DATABASE_URL: z.url(),
  WORKER_ID: z.string().min(1).optional(),
  JOB_CLASSES: z.string().optional(),
  PROCESSES_PER_CLASS: z.coerce.number().int().min(1).default(1),
  MODEL_BACKEND: z.enum(['anthropic', 'standin']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  SUPERVISE_INTERVAL_SECONDS: z.coerce.number().int().positive().optional(),
})

export interface WorkerConfig {
  nodeEnv: 'development' | 'test' | 'production'
  coreUrl: string
  workerSecret: string
  queueUrl: string
  workerId: string
  classes: JobClass[]
  processesPerClass: number
  modelBackend: 'anthropic' | 'standin'
  anthropicApiKey: string | null
  reconcileIntervalSeconds: number
  superviseIntervalSeconds: number | undefined
}

export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(', ')
    throw new Error(`Invalid configuration: ${names}`)
  }
  const c = parsed.data
  const classes = (c.JOB_CLASSES ? c.JOB_CLASSES.split(',').map((s) => s.trim()) : [...JOB_CLASSES]) as JobClass[]
  if (classes.some((k) => !JOB_CLASSES.includes(k))) throw new Error('Invalid configuration: JOB_CLASSES')
  if (c.MODEL_BACKEND === 'standin' && c.NODE_ENV !== 'test') throw new Error('Invalid configuration: MODEL_BACKEND')
  if (c.MODEL_BACKEND === 'anthropic' && !c.ANTHROPIC_API_KEY) throw new Error('Invalid configuration: ANTHROPIC_API_KEY')
  return {
    nodeEnv: c.NODE_ENV,
    coreUrl: c.CORE_URL,
    workerSecret: c.WORKER_SECRET,
    queueUrl: c.QUEUE_DATABASE_URL,
    workerId: c.WORKER_ID ?? `${hostname()}-${process.pid}`,
    classes,
    processesPerClass: c.PROCESSES_PER_CLASS,
    modelBackend: c.MODEL_BACKEND,
    anthropicApiKey: c.ANTHROPIC_API_KEY ?? null,
    reconcileIntervalSeconds: c.RECONCILE_INTERVAL_SECONDS,
    superviseIntervalSeconds: c.SUPERVISE_INTERVAL_SECONDS,
  }
}
```

`apps/worker/src/main.ts`:

```ts
import { openQueue, type JobClass } from '@mkt/queue'
import type { CoreClient } from './core-client.ts'
import type { ModelClient } from './model.ts'
import { runJob, type JobHandler } from './runner.ts'

export interface WorkerOptions {
  core: CoreClient
  model: ModelClient
  handlers: Record<string, JobHandler>
  queueUrl: string
  workerId: string
  classes: JobClass[]
  processesPerClass: number
  superviseIntervalSeconds?: number
}

export async function startWorker(options: WorkerOptions): Promise<{ stop(): Promise<void> }> {
  const queue = await openQueue(options.queueUrl, {
    supervise: true,
    ...(options.superviseIntervalSeconds ? { superviseIntervalSeconds: options.superviseIntervalSeconds } : {}),
  })
  const deps = { core: options.core, model: options.model, handlers: options.handlers, workerId: options.workerId }
  for (const jobClass of options.classes) {
    await queue.work(jobClass, { processes: options.processesPerClass }, (job) => runJob(deps, job))
  }
  return { stop: () => queue.stop() }
}
```

The production entry (below the export, guarded so importing the module in a test does not start anything):

```ts
import { anthropicModel } from './anthropic.ts'
import { loadWorkerConfig } from './config.ts'
import { httpCoreClient } from './core-client.ts'

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadWorkerConfig(process.env)
  // Phase 1 registers no production handler: the trivial agent (package 13) adds its own.
  const handlers: Record<string, JobHandler> = {}
  const model = anthropicModel(config.anthropicApiKey!)
  const worker = await startWorker({
    core: httpCoreClient(config.coreUrl, config.workerSecret),
    model,
    handlers,
    queueUrl: config.queueUrl,
    workerId: config.workerId,
    classes: config.classes,
    processesPerClass: config.processesPerClass,
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void worker.stop().then(() => process.exit(0)))
}
```

In `packages/queue/src/queue.ts`, add `superviseIntervalSeconds?: number` to `OpenOptions` and pass `superviseIntervalSeconds` and `monitorIntervalSeconds` to the `PgBoss` constructor when given (the queue trial used 1 to detect a lost heartbeat in 10 to 25 seconds).

- [ ] **Step 5: Write the crash tests**

`apps/worker/test/child.ts` (the process the tests kill):

```ts
import { httpCoreClient } from '../src/core-client.ts'
import { startWorker } from '../src/main.ts'
import { standInModel } from '../src/standin.ts'
import type { JobHandler } from '../src/runner.ts'

const env = process.env as Record<string, string>

const threeSteps: JobHandler = async (ctx) => {
  const texts: string[] = []
  for (const step of ['step1', 'step2', 'step3']) {
    const out = await ctx.modelStep(step, { model: 'test-model', messages: [{ role: 'user', content: step }], maxTokens: 10 })
    texts.push(out.text)
  }
  return { type: 'test.three_steps', result: { texts } }
}

await startWorker({
  core: httpCoreClient(env.CORE_URL!, env.WORKER_SECRET!),
  model: standInModel({
    logFile: env.MODEL_LOG!,
    crashBeforeReplyOn: env.CRASH_BEFORE_REPLY_ON,
    crashAfterReplyOn: env.CRASH_AFTER_REPLY_ON,
    delayMs: 200,
  }),
  handlers: { 'test.three_steps': threeSteps },
  queueUrl: env.QUEUE_DATABASE_URL!,
  workerId: env.WORKER_ID ?? 'child',
  classes: ['interactive'],
  processesPerClass: 1,
  superviseIntervalSeconds: 1,
})
process.send?.('ready')
setInterval(() => {}, 1 << 30)
```

`apps/worker/test/crash.test.ts`:

```ts
import { fork, type ChildProcess } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { sleep } from '@mkt/test-support'
import { createJob, createRun } from '../../core/src/jobs/service.ts'
import { addBrand, createStack, type Stack } from '../../core/test/support.ts'

let stack: Stack
let brand: string
let definitionId: string
let applied = 0
const children: ChildProcess[] = []

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  brand = await addBrand(stack, 'crash')
  definitionId = await seedDefinition(stack.db)
  await stack.db.admin.query(
    `insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, source)
     values ('test-model', current_date - 30, 4000000, 20000000, 200000, 5000000, 'test')`,
  )
  await stack.db.admin.query(`select app.record_fx_rate(current_date, 83500000, 'test')`)
  stack.jobs.results.set('test.three_steps', async (_c, ctx) => {
    applied += 1
    return { jobId: ctx.jobId }
  })
}, 120_000)

afterAll(async () => {
  for (const c of children) c.kill('SIGKILL')
  await stack?.close()
})

function startChild(logFile: string, extra: Record<string, string>): ChildProcess {
  const child = fork(new URL('./child.ts', import.meta.url).pathname, [], {
    execArgv: ['--experimental-strip-types'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CORE_URL: stack.server.url,
      WORKER_SECRET: stack.jobs.workerSecret,
      QUEUE_DATABASE_URL: stack.db.urlFor('queue'),
      MODEL_LOG: logFile,
      ...extra,
    },
  })
  children.push(child)
  return child
}

async function createThreeStepJob(): Promise<string> {
  return withBrand(stack.appPool, brand, async (client) => {
    const runId = await createRun(client, brand, { agent: 'test-agent', definitionVersionId: definitionId, startedByKind: 'system', startedById: null })
    return createJob(client, stack.jobs, brand, { runId, jobClass: 'interactive', input: {}, expectedResultType: 'test.three_steps' })
  })
}

async function untilFinished(jobId: string, ms = 90_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const { rows } = await stack.db.admin.query('select finished_at from app.job_input where job_id = $1', [jobId])
    if (rows[0]?.finished_at) return
    await sleep(500)
  }
  throw new Error('the job did not finish')
}

const sentCount = (log: string, step: string) => log.split('\n').filter((l) => l === `sent ${step}`).length

describe('a worker that is killed', () => {
  it('test 24: killed mid-job, the job is claimed again as a new attempt and every step with a checkpoint is skipped', async () => {
    const log = join(tmpdir(), `crash24-${randomUUID()}.log`)
    const before = applied
    const jobId = await createThreeStepJob()

    const first = startChild(log, { CRASH_BEFORE_REPLY_ON: 'step2', WORKER_ID: 'first' })
    await new Promise((resolve) => first.once('exit', resolve))

    startChild(log, { WORKER_ID: 'second' })
    await untilFinished(jobId)

    const sent = await readFile(log, 'utf8')
    expect(sentCount(sent, 'step1')).toBe(1) // checkpointed before the crash: never sent again
    expect(sentCount(sent, 'step2')).toBe(2) // the call the crash interrupted, sent again by the new attempt
    expect(sentCount(sent, 'step3')).toBe(1)

    const attempts = await stack.db.admin.query<{ attempt_number: number; state: string; worker_id: string }>(
      'select attempt_number, state, worker_id from app.job_attempt where job_id = $1 order by attempt_number', [jobId])
    expect(attempts.rows).toEqual([
      { attempt_number: 1, state: 'superseded', worker_id: 'first' },
      { attempt_number: 2, state: 'succeeded', worker_id: 'second' },
    ])
    expect(applied).toBe(before + 1)
    await rm(log, { force: true })
  }, 180_000)

  it('test 25: killed after the model replied and before the checkpoint, the retry sends again, is flagged, both calls are in the ledger and one result is applied', async () => {
    const log = join(tmpdir(), `crash25-${randomUUID()}.log`)
    const before = applied
    const jobId = await createThreeStepJob()

    const first = startChild(log, { CRASH_AFTER_REPLY_ON: 'step3', WORKER_ID: 'first' })
    await new Promise((resolve) => first.once('exit', resolve))

    startChild(log, { WORKER_ID: 'second' })
    await untilFinished(jobId)

    const sent = await readFile(log, 'utf8')
    expect(sentCount(sent, 'step1')).toBe(1)
    expect(sentCount(sent, 'step2')).toBe(1)
    expect(sentCount(sent, 'step3')).toBe(2)

    const calls = await stack.db.admin.query<{ step: string; status: string; possible_duplicate: boolean }>(
      `select step, status, possible_duplicate from app.model_call where job_id = $1 order by step, started_at`, [jobId])
    expect(calls.rows).toEqual([
      { step: 'step1', status: 'succeeded', possible_duplicate: false },
      { step: 'step2', status: 'succeeded', possible_duplicate: false },
      { step: 'step3', status: 'started', possible_duplicate: false },
      { step: 'step3', status: 'succeeded', possible_duplicate: true },
    ])
    // The interrupted call was charged by the provider but never reached the ledger: it is the one
    // reconciliation will mark unknown (task 10). Three costs are recorded, one per checkpointed call.
    const costs = await stack.db.admin.query('select count(*)::int as n from app.cost_ledger c join app.model_call m on m.id = c.model_call_id where m.job_id = $1', [jobId])
    expect(costs.rows[0].n).toBe(3)
    expect(applied).toBe(before + 1)
    await rm(log, { force: true })
  }, 180_000)
})
```

`apps/worker/test/crash.test.ts` imports the core's service and test support through relative paths because `apps/core` has no package exports; if a later task gives `@mkt/core` an `exports` map for tests, switch to it. Add `apps/core` test support to the worker's `tsconfig` include through the root `tsconfig.json`'s existing `apps/*/test/**` glob (no change needed).

- [ ] **Step 6: Run**

Run (server): `npx vitest run apps/worker`. Expected: PASS. Each crash test takes about 30 to 60 seconds: the class settings are scaled (heartbeat gap 10 seconds) and the supervisor runs every second.

If the job is never reclaimed, check in this order: (1) `pgboss.job` for the job's state and `heartbeat_on`: an `active` job with an old heartbeat that is not moving to `retry` means the second worker is not supervising (`supervise: true`); (2) the queue was created with heartbeats (Task 1's `createQueue` options); (3) the library's option name for the supervision interval.

- [ ] **Step 7: Commit**

```bash
git add apps/worker packages/queue package.json package-lock.json
git commit -m "feat(worker): claim, run steps with checkpoints, and survive a kill at either point"
```

---

### Task 10: Dead letters, reconciliation and the watchdog (acceptance test 28)

**Files:**

- Create: `apps/core/src/jobs/dead.ts`, `apps/core/src/routes/jobs.ts`, `apps/worker/src/maintenance.ts`
- Modify: `packages/queue/src/queue.ts` (`onDead`), `apps/core/src/routes/worker.ts` (two routes), `apps/core/src/api.ts`, `apps/worker/src/main.ts`, `apps/worker/src/core-client.ts`
- Test: `apps/core/test/jobs-dead.test.ts`, `apps/worker/test/dead-letter.test.ts`, `apps/worker/test/maintenance.test.ts`

**Interfaces:**

- Consumes: Task 3's `Queue`; Task 7's tables; `see_other_brands` from `apps/core/src/access/permissions.ts`.
- Produces:

```ts
// queue.ts, added to Queue
onDead(jobClass: JobClass, handler: (jobId: string) => Promise<void>): Promise<void>

// dead.ts
export interface DeadJob { jobId: string; runId: string; jobClass: JobClass; deadAt: string; attempts: number }
export function markDead(deps: JobsDeps, jobId: string): Promise<void>
export function listDead(deps: JobsDeps, brandId: string): Promise<DeadJob[]>
export function requeueJob(deps: JobsDeps, brandId: string, jobId: string, actor: string): Promise<void>
export function cancelJob(deps: JobsDeps, brandId: string, jobId: string, actor: string): Promise<void>
export function sweepModelCalls(deps: JobsDeps): Promise<number>
```

Routes: `POST /worker/jobs/:jobId/dead` (access `worker`), `POST /worker/reconcile` (access `worker`), `GET /brands/:brandId/jobs/dead`, `POST /brands/:brandId/jobs/:jobId/requeue`, `POST /brands/:brandId/jobs/:jobId/cancel` (access `permission: see_other_brands`, plan decision 7).

- [ ] **Step 1: Write the core test**

`apps/core/test/jobs-dead.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { cancelJob, listDead, markDead, requeueJob, sweepModelCalls } from '../src/jobs/dead.ts'
import { createJob, createRun, startAttempt } from '../src/jobs/service.ts'
import { addBrand, createStack, type Stack } from './support.ts'

let stack: Stack
let brandA: string
let brandB: string
let definitionId: string
const ACTOR = '99999999-9999-4999-8999-999999999999'

async function makeJob(brandId: string): Promise<{ jobId: string; runId: string }> {
  let runId = ''
  const jobId = await withBrand(stack.appPool, brandId, async (client) => {
    runId = await createRun(client, brandId, { agent: 'test-agent', definitionVersionId: definitionId, startedByKind: 'system', startedById: null })
    return createJob(client, stack.jobs, brandId, { runId, jobClass: 'interactive', input: {}, expectedResultType: 'test.echo' })
  })
  return { jobId, runId }
}
// What the library does after the last retry: the job is failed, and a copy goes to the dead-letter queue.
const kill = (jobId: string) => stack.db.admin.query(`update pgboss.job set state = 'failed' where id = $1`, [jobId])
const runState = async (runId: string) => (await stack.db.admin.query('select state from app.run where id = $1', [runId])).rows[0].state

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  brandA = await addBrand(stack, 'dead-a')
  brandB = await addBrand(stack, 'dead-b')
  definitionId = await seedDefinition(stack.db)
})
afterAll(async () => {
  await stack?.close()
})

describe('dead jobs', () => {
  it('marks a job dead, fails its run, lists it for its own brand only, and audits it', async () => {
    const { jobId, runId } = await makeJob(brandA)
    await kill(jobId)
    await markDead(stack.jobs, jobId)
    expect(await runState(runId)).toBe('failed')
    expect((await listDead(stack.jobs, brandA)).map((j) => j.jobId)).toContain(jobId)
    expect((await listDead(stack.jobs, brandB)).map((j) => j.jobId)).not.toContain(jobId)
    const audit = await stack.db.admin.query(`select actor_kind from audit.log where action = 'jobs.dead' and subject = $1`, [jobId])
    expect(audit.rows[0].actor_kind).toBe('system')
  })

  it('requeues a dead job: the queue retries it, the list clears, the run runs again, the user is the actor', async () => {
    const { jobId, runId } = await makeJob(brandA)
    await kill(jobId)
    await markDead(stack.jobs, jobId)
    await requeueJob(stack.jobs, brandA, jobId, ACTOR)
    expect(await stack.jobs.queue.state('interactive', jobId)).toBe('retry')
    expect((await listDead(stack.jobs, brandA)).map((j) => j.jobId)).not.toContain(jobId)
    expect(await runState(runId)).toBe('running')
    const audit = await stack.db.admin.query(`select actor_id from audit.log where action = 'jobs.requeued' and subject = $1`, [jobId])
    expect(audit.rows[0].actor_id).toBe(ACTOR)
  })

  it('cancels a dead job and ends its run', async () => {
    const { jobId, runId } = await makeJob(brandA)
    await kill(jobId)
    await markDead(stack.jobs, jobId)
    await cancelJob(stack.jobs, brandA, jobId, ACTOR)
    expect(await stack.jobs.queue.state('interactive', jobId)).toBe('cancelled')
    expect(await runState(runId)).toBe('cancelled')
  })

  it('refuses to requeue or cancel a job that is not dead, or one in another brand', async () => {
    const { jobId } = await makeJob(brandA)
    await expect(requeueJob(stack.jobs, brandA, jobId, ACTOR)).rejects.toMatchObject({ status: 409, code: 'job_not_dead' })
    await kill(jobId)
    await markDead(stack.jobs, jobId)
    await expect(requeueJob(stack.jobs, brandB, jobId, ACTOR)).rejects.toMatchObject({ status: 404 })
    await expect(cancelJob(stack.jobs, brandB, jobId, ACTOR)).rejects.toMatchObject({ status: 404 })
  })

  it('does not list a requeued job as dead once its next attempt starts', async () => {
    const { jobId } = await makeJob(brandA)
    await kill(jobId)
    await markDead(stack.jobs, jobId)
    // The queue retried it but the database was not cleared (the order in requeueJob makes this the failure case).
    await stack.jobs.queue.requeue('interactive', jobId)
    await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [jobId])
    await startAttempt(stack.jobs, jobId, 'w1')
    expect((await listDead(stack.jobs, brandA)).map((j) => j.jobId)).not.toContain(jobId)
  })
})

describe('reconciliation', () => {
  it('marks started calls older than the class expiry unknown, per class, and leaves newer ones', async () => {
    const { jobId, runId } = await makeJob(brandA)
    await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [jobId])
    const started = await startAttempt(stack.jobs, jobId, 'w1')
    if (started.finished) throw new Error('unexpected')
    await withBrand(stack.appPool, brandA, (c) =>
      c.query(
        `insert into app.model_call (brand_id, run_id, job_id, attempt_id, step, request_hash, model, started_at)
         values ($1, $2, $3, $4, 'old', 'h1', 'm', now() - interval '10 minutes'),
                ($1, $2, $3, $4, 'new', 'h2', 'm', now() - interval '1 minute')`,
        [brandA, runId, jobId, started.attemptId],
      ),
    )
    // Interactive jobs expire after 5 minutes: the 10-minute-old call is past it, the 1-minute-old one is not.
    expect(await sweepModelCalls(stack.jobs)).toBeGreaterThanOrEqual(1)
    const rows = await stack.db.admin.query('select step, status from app.model_call where job_id = $1 order by step', [jobId])
    expect(rows.rows).toEqual([
      { step: 'new', status: 'started' },
      { step: 'old', status: 'unknown' },
    ])
  })
})
```

The HTTP half, in the same file, as the platform owner and as a brand admin of brand A. Use the helpers `enrolledClient`, `addUser` and `TestClient.request` from `apps/core/test/support.ts` exactly as `apps/core/test/users-list-invite.test.ts` does:

```ts
describe('the job routes', () => {
  it('lets the platform owner list, requeue and cancel, refuses a brand admin, and hides the brand from a stranger', async () => {
    const owner = await enrolledClient(stack, { platformOwner: true })
    const admin = await enrolledClient(stack, { role: 'brand_admin', brandId: brandA })
    const stranger = await enrolledClient(stack, { role: 'brand_admin', brandId: brandB })
    const { jobId } = await makeJob(brandA)
    await kill(jobId)
    await markDead(stack.jobs, jobId)

    const list = await owner.request('get', `/api/v1/brands/${brandA}/jobs/dead`)
    expect(list.status).toBe(200)
    expect((await list.json()).map((j: { jobId: string }) => j.jobId)).toContain(jobId)

    expect((await admin.request('get', `/api/v1/brands/${brandA}/jobs/dead`)).status).toBe(403)
    expect((await stranger.request('get', `/api/v1/brands/${brandA}/jobs/dead`)).status).toBe(404)
    expect((await admin.request('post', `/api/v1/brands/${brandA}/jobs/${jobId}/requeue`)).status).toBe(403)

    expect((await owner.request('post', `/api/v1/brands/${brandA}/jobs/${jobId}/requeue`)).status).toBe(204)
    expect((await owner.request('post', `/api/v1/brands/${brandA}/jobs/${jobId}/requeue`)).status).toBe(409)
  })
})
```

If `enrolledClient`'s option names differ, read its signature in `support.ts` and match it.

- [ ] **Step 2: Run it to see it fail**

Run (server): `npx vitest run apps/core/test/jobs-dead.test.ts`. Expected: FAIL, `markDead` is not exported.

- [ ] **Step 3: Write `dead.ts`**

```ts
import { withBrand } from '@mkt/db'
import { CLASS_SETTINGS, JOB_CLASSES, type JobClass } from '@mkt/queue'
import { AppError } from '../errors.ts'
import type { JobsDeps } from './service.ts'

export interface DeadJob {
  jobId: string
  runId: string
  jobClass: JobClass
  deadAt: string
  attempts: number
}

async function brandOf(deps: JobsDeps, jobId: string): Promise<string> {
  const { rows } = await deps.pool.query<{ brand: string | null }>('select app.job_brand($1) as brand', [jobId])
  const brand = rows[0]?.brand
  if (!brand) throw new AppError(404, 'job_not_found', 'No such job.')
  return brand
}

// Called by the worker's dead-letter watcher when the library has given up on a job.
export async function markDead(deps: JobsDeps, jobId: string): Promise<void> {
  const brandId = await brandOf(deps, jobId)
  await withBrand(deps.pool, brandId, async (client) => {
    await client.query(
      'update app.job_control set dead_at = coalesce(dead_at, now()), updated_at = now() where job_id = $1',
      [jobId],
    )
    await client.query(
      `update app.run set state = 'failed', finished_at = now()
        where id = (select run_id from app.job_input where job_id = $1) and state in ('created', 'running')`,
      [jobId],
    )
    await deps.audit.record(
      { action: 'jobs.dead', actor: null, brandId, subject: jobId, outcome: 'success', detail: { jobId } },
      client,
    )
  })
}

export async function listDead(deps: JobsDeps, brandId: string): Promise<DeadJob[]> {
  return withBrand(deps.pool, brandId, async (client) => {
    const { rows } = await client.query<{ job_id: string; run_id: string; class: JobClass; dead_at: Date; attempts: string }>(
      `select c.job_id, i.run_id, i.class, c.dead_at,
              (select count(*) from app.job_attempt a where a.job_id = c.job_id) as attempts
         from app.job_control c join app.job_input i on i.job_id = c.job_id
        where c.dead_at is not null and i.finished_at is null
        order by c.dead_at desc`,
    )
    return rows.map((r) => ({
      jobId: r.job_id,
      runId: r.run_id,
      jobClass: r.class,
      deadAt: r.dead_at.toISOString(),
      attempts: Number(r.attempts),
    }))
  })
}

async function requireDead(client: import('@mkt/db').PoolClient, jobId: string): Promise<{ jobClass: JobClass; runId: string }> {
  const { rows } = await client.query<{ class: JobClass; run_id: string; dead_at: Date | null; finished_at: Date | null }>(
    `select i.class, i.run_id, c.dead_at, i.finished_at
       from app.job_input i join app.job_control c on c.job_id = i.job_id
      where i.job_id = $1 for update of c`,
    [jobId],
  )
  const row = rows[0]
  if (!row) throw new AppError(404, 'job_not_found', 'No such job.')
  if (!row.dead_at || row.finished_at) throw new AppError(409, 'job_not_dead', 'This job is not in the dead-letter list.')
  return { jobClass: row.class, runId: row.run_id }
}

// The queue is asked first, the database second: a job the queue has retried and the database still lists
// as dead is cleared by its next attempt (startAttempt), whereas the reverse would list a job as live that
// the queue will never run.
export async function requeueJob(deps: JobsDeps, brandId: string, jobId: string, actor: string): Promise<void> {
  await withBrand(deps.pool, brandId, async (client) => {
    const { jobClass, runId } = await requireDead(client, jobId)
    await deps.queue.requeue(jobClass, jobId)
    await client.query('update app.job_control set dead_at = null, updated_at = now() where job_id = $1', [jobId])
    await client.query(`update app.run set state = 'running', finished_at = null where id = $1`, [runId])
    await deps.audit.record(
      { action: 'jobs.requeued', actor, brandId, subject: jobId, outcome: 'success', detail: { jobId } },
      client,
    )
  })
}

export async function cancelJob(deps: JobsDeps, brandId: string, jobId: string, actor: string): Promise<void> {
  await withBrand(deps.pool, brandId, async (client) => {
    const { jobClass, runId } = await requireDead(client, jobId)
    await deps.queue.cancel(jobClass, jobId)
    await client.query(
      'update app.job_control set cancel_requested = true, dead_at = null, updated_at = now() where job_id = $1',
      [jobId],
    )
    await client.query(
      `update app.run set state = 'cancelled', finished_at = now()
        where id = $1 and not exists (
          select 1 from app.job_input i join app.job_control c on c.job_id = i.job_id
           where i.run_id = $1 and i.finished_at is null and not c.cancel_requested)`,
      [runId],
    )
    await deps.audit.record(
      { action: 'jobs.cancelled', actor, brandId, subject: jobId, outcome: 'success', detail: { jobId } },
      client,
    )
  })
}

// Spec 9.5, reconciliation: a call still "started" after its class's expiry becomes "unknown".
export async function sweepModelCalls(deps: JobsDeps): Promise<number> {
  let marked = 0
  for (const jobClass of JOB_CLASSES) {
    const cutoff = new Date(deps.now().getTime() - CLASS_SETTINGS[jobClass].expireInSeconds * 1000)
    const { rows } = await deps.pool.query<{ n: number }>('select app.sweep_model_calls($1::app.job_class, $2) as n', [jobClass, cutoff])
    marked += rows[0]?.n ?? 0
  }
  return marked
}
```

Routes in `apps/core/src/routes/jobs.ts`, in the style of `routes/users.ts`: `GET /brands/:brandId/jobs/dead` answers `listDead`; the two `POST` routes call `requeueJob` / `cancelJob` with `actor = principalOf(res).userId` and answer 204. All three are `access: { kind: 'permission', permission: 'see_other_brands' }`. `routes/worker.ts` gets `POST /worker/jobs/:jobId/dead` (answers 204) and `POST /worker/reconcile` (answers `{ marked }`), both `access: { kind: 'worker' }`.

- [ ] **Step 4: Add `onDead` to the queue**

In `packages/queue/src/queue.ts`:

```ts
    async onDead(jobClass, handler) {
      const s = CLASS_SETTINGS[jobClass]
      await boss.work(s.deadLetter, { pollingIntervalSeconds: s.pollingIntervalSeconds }, async (batch) => {
        for (const copy of batch) {
          const jobId = (copy.data as { jobId?: string }).jobId
          if (jobId) await handler(jobId)
        }
      })
    },
```

and add it to the `Queue` interface. Handling the copy completes it, so the dead-letter queue stays empty: the business tables are the list (plan decision 4).

- [ ] **Step 5: Worker maintenance**

`apps/worker/src/maintenance.ts`:

```ts
import type { JobClass, Queue } from '@mkt/queue'
import type { CoreClient } from './core-client.ts'

export interface Maintenance {
  stop(): void
}

// Until n8n's scheduled trigger exists (milestone 6): sweep model calls, and report what the watchdog sees.
export function startMaintenance(options: {
  core: CoreClient
  queue: Queue
  intervalSeconds: number
  maxWaitSeconds: Record<JobClass, number>
  log: (line: Record<string, unknown>) => void
}): Maintenance {
  const tick = async () => {
    try {
      const swept = await options.core.reconcile()
      const seen = await options.queue.watchdog(new Date(), { maxWaitSeconds: options.maxWaitSeconds })
      options.log({ event: 'maintenance', marked_unknown: swept.marked, waiting_too_long: seen.waiting.length, running_too_long: seen.running.length })
    } catch (error) {
      options.log({ event: 'maintenance_failed', error: error instanceof Error ? error.message : String(error) })
    }
  }
  const timer = setInterval(() => void tick(), options.intervalSeconds * 1000)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
```

In `startWorker` (`CoreClient.reconcile` and `CoreClient.jobDead` already exist from task 9), after the `work` loop, add `await queue.onDead(jobClass, (id) => options.core.jobDead(id))` for each class and start maintenance with `maxWaitSeconds` of `{ interactive: 60, publishing: 120, production: 900, bulk: 3600 }` (a first estimate, one line in configuration, to be tuned with the first real load).

`apps/worker/test/maintenance.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Queue } from '@mkt/queue'
import type { CoreClient } from '../src/core-client.ts'
import { startMaintenance } from '../src/maintenance.ts'

const queue = { watchdog: async () => ({ waiting: ['a', 'b'], running: ['c'] }) } as unknown as Queue
const limits = { interactive: 60, publishing: 120, production: 900, bulk: 3600 }

describe('maintenance', () => {
  it('sweeps, reads the watchdog and logs the counts on each tick', async () => {
    const lines: Record<string, unknown>[] = []
    const core = { reconcile: async () => ({ marked: 4 }) } as unknown as CoreClient
    const m = startMaintenance({ core, queue, intervalSeconds: 0.05, maxWaitSeconds: limits, log: (l) => lines.push(l) })
    await new Promise((r) => setTimeout(r, 200))
    m.stop()
    expect(lines[0]).toEqual({ event: 'maintenance', marked_unknown: 4, waiting_too_long: 2, running_too_long: 1 })
  })

  it('logs a failure and keeps ticking', async () => {
    const lines: Record<string, unknown>[] = []
    let calls = 0
    const core = {
      reconcile: async () => {
        calls += 1
        throw new Error('core down')
      },
    } as unknown as CoreClient
    const m = startMaintenance({ core, queue, intervalSeconds: 0.05, maxWaitSeconds: limits, log: (l) => lines.push(l) })
    await new Promise((r) => setTimeout(r, 250))
    m.stop()
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(lines.every((l) => l.event === 'maintenance_failed')).toBe(true)
  })
})
```

`intervalSeconds` is a number of seconds and may be fractional; `setInterval` takes milliseconds, which `intervalSeconds * 1000` gives.

- [ ] **Step 6: Write the end-to-end dead-letter test**

`apps/worker/test/dead-letter.test.ts` (the worker runs in this process, against the scaled test queue):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { sleep } from '@mkt/test-support'
import { listDead, requeueJob } from '../../core/src/jobs/dead.ts'
import { createJob, createRun } from '../../core/src/jobs/service.ts'
import { addBrand, createStack, type Stack } from '../../core/test/support.ts'
import { httpCoreClient } from '../src/core-client.ts'
import { startWorker } from '../src/main.ts'
import { standInModel } from '../src/standin.ts'

let stack: Stack
let brand: string
let definitionId: string
let worker: { stop(): Promise<void> }
let shouldFail = true
let handlerRuns = 0
const OWNER = '88888888-8888-4888-8888-888888888888'

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  brand = await addBrand(stack, 'dead-letter')
  definitionId = await seedDefinition(stack.db)
  stack.jobs.results.set('test.flaky', async () => ({ ok: true }))
  worker = await startWorker({
    core: httpCoreClient(stack.server.url, stack.jobs.workerSecret),
    model: standInModel({ logFile: '/dev/null' }),
    handlers: {
      'test.flaky': async () => {
        handlerRuns += 1
        if (shouldFail) throw new Error('boom')
        return { type: 'test.flaky', result: {} }
      },
    },
    queueUrl: stack.db.urlFor('queue'),
    workerId: 'in-process',
    classes: ['interactive'],
    processesPerClass: 1,
    superviseIntervalSeconds: 1,
  })
}, 120_000)

afterAll(async () => {
  await worker?.stop()
  await stack?.close()
})

async function until(check: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(500)
  }
  throw new Error('condition not reached in time')
}

describe('acceptance test 28', () => {
  it('a job that keeps failing lands in the dead-letter list and can be requeued', async () => {
    let runId = ''
    const jobId = await withBrand(stack.appPool, brand, async (client) => {
      runId = await createRun(client, brand, { agent: 'test-agent', definitionVersionId: definitionId, startedByKind: 'system', startedById: null })
      return createJob(client, stack.jobs, brand, { runId, jobClass: 'interactive', input: {}, expectedResultType: 'test.flaky' })
    })

    // Three attempts (retryLimit 2, plus the first), then the library gives up and the watcher marks it.
    await until(async () => (await listDead(stack.jobs, brand)).some((j) => j.jobId === jobId), 150_000)
    expect(handlerRuns).toBe(3)
    const attempts = await stack.db.admin.query('select state from app.job_attempt where job_id = $1', [jobId])
    expect(attempts.rowCount).toBe(3)
    expect(attempts.rows.every((r) => r.state !== 'active')).toBe(true)
    expect((await stack.db.admin.query('select state from app.run where id = $1', [runId])).rows[0].state).toBe('failed')

    shouldFail = false
    await requeueJob(stack.jobs, brand, jobId, OWNER)
    await until(async () => (await stack.db.admin.query('select finished_at from app.job_input where job_id = $1', [jobId])).rows[0].finished_at !== null, 90_000)
    expect(await listDead(stack.jobs, brand)).toEqual([])
    expect((await stack.db.admin.query('select state from app.run where id = $1', [runId])).rows[0].state).toBe('succeeded')

    const actions = await stack.db.admin.query(`select action from audit.log where subject = $1 order by at`, [jobId])
    expect(actions.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['jobs.dead', 'jobs.requeued']))
  }, 300_000)
})
```

- [ ] **Step 7: Run**

Run (server): `npx vitest run apps/core apps/worker packages/queue`. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps packages
git commit -m "feat(jobs): dead-letter list, requeue and cancel, the model-call sweep and the watchdog read"
```

---

### Task 11: Record, verify, and merge

**Files:**

- Modify: `docs/progress.md`, `docs/database/2026-10-04-database-schema.md` (section 7.3, 7.5, 7.6, new 7.9, section 11.1), `docs/dev-environment.md` (the worker and queue URLs), `docs/trials/` (a one-page note of any library behaviour that differed from the plan: option names, grants)
- Create: `docs/plans/m4-work-engine.docx` (generated)

**Interfaces:**

- Consumes: everything above.
- Produces: the milestone record and the merge.

- [ ] **Step 1: Run the whole suite twice and confirm nothing is left behind**

Run (server), twice: `npm ci && npm run verify`. Expected both times: every step passes, including `npm run check:pins` (the worker's `@anthropic-ai/sdk` is the same exact version as `stack-check`'s), `npm run lint` (no `pg`, `kysely` or `pg-boss` import outside the allowed packages), and `npm run secrets`. Confirm no test database is left behind (`ssh root@<dev-server> "docker exec mkt-dev-postgres-1 psql -U mkt -d postgres -Atc \"select count(*) from pg_database where datname like 'mkt_t_%'\""` prints `0`), and that no worker child process is left running on the server.

- [ ] **Step 2: Scan the branch for the server address**

Run: `git log main..HEAD -p | grep -c '<the server address>'`. Expected: `0`. Also check the new files for `stg.marketing`, and for any key, secret or password other than the `CHANGE_ME` and `dev_only` placeholders. Fix any occurrence before pushing.

- [ ] **Step 3: Update the database schema document**

In `docs/database/2026-10-04-database-schema.md`: 7.3 gains `expected_result_type`, `result_type`, `outcome`, `held_result` and `finished_at` (plan decision 4); 7.5 gains `dead_at`; 7.6 notes that a call whose model has no price, or when no exchange rate exists, is `succeeded` with no cost fields and no ledger row; a new 7.9 `app.model_price` (the columns of migration 0012 and the rule in plan decision 5); 11.1 says "Queue: claim and update jobs in `pgboss`; Application: create jobs in `pgboss` (insert on the job table, select on the queue table) and nothing else there; Owner-view: execute `app.record_fx_rate`". Run `npx prettier --check docs` on the server.

- [ ] **Step 4: Record the milestone**

Append to `docs/progress.md` a section "Phase 1, milestone 4: Work engine" in the style of the earlier sections: the commit range; packages 7 and 8 done; the acceptance tests proven (6, 24, 25, 26, 27, 28, 29, 32, each with the test file that proves it: 6, 26, 32 in `worker-attempts.test.ts` and `attempt-token.test.ts`; 24 and 25 in `apps/worker/test/crash.test.ts` with the ledger half in `model-calls.test.ts`; 27 in `job-results.test.ts`; 28 in `apps/worker/test/dead-letter.test.ts`; 29 in `packages/queue/test/fairness.test.ts`); what is not proven and why (tests 30 and 31 and the kill switch's cancel-and-hold of waiting jobs wait for package 12; alerts for dead, long-waiting and unknown calls wait for package 11; daily jobs wait for n8n triggers, milestone 6; the real provider call waits for owner item A3 and the model price figures; the exchange-rate fetch waits for a source and milestone 6); the ten decisions as accepted by the owner on the date they were; every ruling made during the work, in plain words, rulings first; the findings; the deployment preconditions new in this milestone (the core needs `QUEUE_DATABASE_URL`, `WORKER_SECRET`, `ATTEMPT_TOKEN_SECRET`; the worker needs `CORE_URL`, `WORKER_SECRET`, `QUEUE_DATABASE_URL` and the provider key; `installQueue` runs once at deployment as the database owner; model prices and the first exchange rate are entered before the first real call; the proxy must pass `Authorization` on `/api/v1/worker/`); and the follow-ups carried forward. Run `npx prettier --check docs/progress.md` on the server.

- [ ] **Step 5: Make the Word copy**

Run (server): `cd tools/build-docs && PUPPETEER_SKIP_DOWNLOAD=1 npm ci --ignore-scripts && node md2docx.js ../../docs/plans/2026-10-13-m4-work-engine.md /work/.m4-plan.docx`, copy it to `docs/plans/m4-work-engine.docx` and delete the temporary file on the server. The schema document's Word copy needs `mmdc` (not on the server); leave it as in milestone 3 and say so in the pull request. The Markdown stays canonical.

- [ ] **Step 6: Commit, push, open the pull request, wait for CI, merge**

```
git add docs
git commit -m "docs: milestone 4 results"
git push -u origin m4-work-engine
gh pr create --base main --head m4-work-engine --title "Milestone 4: work engine (packages 7 and 8)" --body-file <description>
```

The description states what was added, the decisions the owner accepted, every ruling and finding, what was run (the two verify runs), what is not proven, and the deployment preconditions; it ends with the attribution line the session gives. Wait for the pull request's workflow run to succeed, then merge with a merge commit (`gh pr merge --merge`): the owner's standing instruction (2026-10-04) is to push and merge without asking once the checks pass and the reviews are clean. If the merge is refused by a permission rule, stop and tell the owner; do not work around it.

- [ ] **Step 7: Report to the owner**

State what passed, every ruling and finding, anything that differs from this plan, and what is not proven yet.
