import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createPool, withBrand, type Pool } from '@mkt/db'
import {
  appRoleCannotDisableSecurity,
  brandIdInForeignKeys,
  brandIdUniqueKeys,
  brandPolicies,
  brandScopedTables,
  brandTableShowsOnlyOwn,
  noPublicFunctions,
  refusesCrossBrandParent,
  refusesInsertForOtherBrand,
  refusesInsertWithoutBrand,
  refusesUpdateToOtherBrand,
  rowSecurityForced,
  scopedTablesFound,
  SEEDED,
  seedProbeBrand,
  seesNothingWithoutBrand,
  seesOnlyOwnBrand,
  seesOwnBrandRows,
  serviceRolesReadNoBusinessTable,
  type AsRole,
} from '@mkt/db/isolation-probes'
import { openQueue, type JobClass, type Queue } from '@mkt/queue'
import { totp } from '@mkt/test-support'
import {
  attemptTokenFindings,
  brandScopedRoutes,
  otherBrandFindings,
  ownBrandFindings,
  type ProbeReply,
  type ProbeRoute,
} from '../../core/src/access/isolation-probes.ts'
import { startSummaryRun } from '../../core/src/agents/start.ts'
import { DbAudit } from '../../core/src/audit/db-audit.ts'
import { verifyAudit } from '../../core/src/audit/verify.ts'
import { AttemptLimiter } from '../../core/src/auth/limiter.ts'
import { createAuth } from '../../core/src/auth/options.ts'
import { LOCK_DURATION_MS, LOCK_MAX_FAILURES, LOCK_WINDOW_MS } from '../../core/src/auth/policy.ts'
import { createUserWithPassword } from '../../core/src/auth/users.ts'
import { loadConfig } from '../../core/src/config.ts'
import { buildCore } from '../../core/src/core.ts'
import { currentQueueId, finaliseRun, type JobsDeps } from '../../core/src/jobs/service.ts'
import { createLogger } from '../../core/src/logger.ts'
import { errorName } from '../../core/src/notify/ports.ts'
import { StandInFxSource } from '../../core/src/triggers/fx.ts'

// Acceptance test 40, the restore drill (plan, Task 9; docs/operations.md, "Restore drill"). Run against a
// database that restore.sh has filled from a backup, after `ops prepare` gave its run-time roles their
// passwords:
//
//   npm run restore-check --workspace @mkt/ops -- --target postgres://postgres@<host>:5432/mkt
//
// The target names the superuser and no password (an address with one is refused, as restore.sh refuses it):
// the password comes from PGPASSWORD. The rest comes from the environment too, never from the arguments: the
// run-time roles' passwords (MKT_APP_PASSWORD, MKT_AUDIT_WRITER_PASSWORD, MKT_QUEUE_PASSWORD,
// MKT_OWNER_VIEW_PASSWORD, as in roles.env), the core's four secrets and PUBLIC_ORIGIN (core.env: the
// second factor is stored encrypted with AUTH_SECRET), and the drill file written by `seed` before the backup
// (RESTORE_DRILL_EMAIL, RESTORE_DRILL_PASSWORD, RESTORE_DRILL_TOTP_SECRET, RESTORE_DRILL_JOB_ID).
//
// It starts a real core process (apps/core/src/main.ts) and a real worker process (the stand-in model) on the
// restored copy, and prints one line per check, PASS or FAIL, and exits 1 if any failed:
//   1. the drill user signs in with the password and the second factor, over HTTP, through that core;
//   2. the drill job, waiting in the queue when the backup was taken, is claimed and its run succeeds;
//   3. verifyAudit passes for every chain;
//   4. tenant-isolation tests 1 to 6 hold: the database probes (packages/db/src/isolation-probes.ts) on the
//      restored brands and on two probe brands written in a transaction that is rolled back, the route walk
//      and the attempt-token probe (apps/core/src/access/isolation-probes.ts) against the core.
// The copy is throw-away and is changed by the drill (sign-ins, the job run, test 6's jobs). Nothing printed
// carries a secret, a code, an address or a row's content; a failure names a route pattern, table, status or
// error name. The children's own output is discarded for the same reason.
//
// `seed` prepares the drill on the database that will be backed up (docs/operations.md says when):
//   RESTORE_DRILL_FILE=<new file> npm run restore-drill-seed --workspace @mkt/ops -- --target <admin address>
// It creates the brands restore-drill-a and restore-drill-b, the drill user (brand admin in restore-drill-a
// only, address restore-drill@drill.invalid) enrolled in the second factor through the sign-in library with
// the core's AUTH_SECRET, a content item in each brand, and one waiting summary job in restore-drill-a; then
// writes the drill file (mode 0600, refused if it exists). The secret is the drill user's own, made here. The
// file also names the live database (cluster system identifier and database name): restore-check refuses that
// database, and any target host named `postgres` (the live service), before it starts anything.
// `cancel-live` (after the backup, before the live worker starts) cancels the drill's waiting jobs on the live
// database, so no drill job ever reaches the real model. `unseed` (when the drill file is lost) cancels them and
// removes the drill user; the next seed starts over.
//
// Dependencies: the drill imports the core's code (relative paths, as apps/dashboard/e2e does) and starts the
// core and the worker, so @mkt/core and @mkt/worker are devDependencies of @mkt/ops: the drill runs only from a
// full checkout (`npm ci`), never in the ops image, which installs production dependencies only and whose entry
// (main.ts) never loads this file. @mkt/test-support (the TOTP codes) is a dependency.

export const DRILL_EMAIL = 'restore-drill@drill.invalid'
export const DRILL_BRANDS = { own: 'restore-drill-a', other: 'restore-drill-b' } as const
const DRILL_BRIEF = 'Restore drill: a two-line summary of a restored database, plain tone.'
// A well-formed id that names no row, for route parameters with nothing real to point at.
const NO_ROW = '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b'
const CORE_MAIN = fileURLToPath(new URL('../../core/src/main.ts', import.meta.url))
const WORKER_MAIN = fileURLToPath(new URL('../../worker/src/main.ts', import.meta.url))
const ROLE_PASSWORDS = {
  app: 'MKT_APP_PASSWORD',
  audit_writer: 'MKT_AUDIT_WRITER_PASSWORD',
  queue: 'MKT_QUEUE_PASSWORD',
  owner_view: 'MKT_OWNER_VIEW_PASSWORD',
} as const
const CORE_SECRETS = ['AUTH_SECRET', 'WORKER_SECRET', 'ATTEMPT_TOKEN_SECRET', 'TRIGGER_SECRET'] as const
const DRILL_ACCOUNT = [
  'RESTORE_DRILL_EMAIL',
  'RESTORE_DRILL_PASSWORD',
  'RESTORE_DRILL_TOTP_SECRET',
  'RESTORE_DRILL_JOB_ID',
] as const
// RESTORE_DRILL_LIVE_DATABASE names the live database the seed ran on (cluster system identifier and
// database name): restore-check refuses that database, so the drill can never run on the live data.
const DRILL_VARS = [...DRILL_ACCOUNT, 'RESTORE_DRILL_LIVE_DATABASE'] as const
// The live database's service name in compose.yaml. A drill target is always a throw-away container.
const LIVE_HOST = 'postgres'

type Env = Record<string, string | undefined>

export class Refused extends Error {
  override name = 'Refused'
}

// --target <postgres://superuser@host:port/db>: an address with a password is refused, so none is ever in a
// process's arguments. Nothing else is accepted on the command line.
export function parseTarget(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== '--target') throw new Refused('usage: --target <postgres address>')
  let url: URL
  try {
    url = new URL(args[1] as string)
  } catch {
    throw new Refused('the target is not a postgres:// address')
  }
  if (!/^postgres(ql)?:$/.test(url.protocol) || !url.hostname || url.pathname.length < 2) {
    throw new Refused('the target is not a postgres:// address')
  }
  if (url.password !== '') throw new Refused('the target address carries a password; give it in PGPASSWORD')
  return url.toString()
}

function required(env: Env, names: readonly string[]): Record<string, string> {
  const missing = names.filter((name) => !env[name])
  if (missing.length > 0) throw new Refused(`missing in the environment: ${missing.join(', ')}`)
  return Object.fromEntries(names.map((name) => [name, env[name] as string]))
}

function roleUrl(target: string, role: string, password: string): string {
  const url = new URL(target)
  url.username = `mkt_${role}`
  url.password = password
  return url.toString()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

// A child process with no output kept (it could carry data) and only PATH from this process's environment.
function startChild(file: string, env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, [file], {
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...env },
    stdio: 'ignore',
  })
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 45_000)
  await exited
  clearTimeout(timer)
}

// The session of one person, as a browser holds it: cookies, the origin header and the request token.
class Session {
  private readonly cookies = new Map<string, string>()
  private csrf: string | null = null
  private readonly base: string
  private readonly origin: string

  constructor(base: string, origin: string) {
    this.base = base
    this.origin = origin
  }

  async request(method: string, path: string, body?: unknown): Promise<ProbeReply & { json: unknown }> {
    const headers: Record<string, string> = { origin: this.origin }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    if (this.csrf) headers['x-csrf-token'] = this.csrf
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? ''
      const at = pair.indexOf('=')
      const value = pair.slice(at + 1)
      if (value === '' || /;\s*Max-Age=0/i.test(line)) this.cookies.delete(pair.slice(0, at))
      else this.cookies.set(pair.slice(0, at), value)
    }
    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, text, json }
  }

  async refreshCsrf(): Promise<unknown> {
    const reply = await this.request('GET', '/api/v1/session')
    this.csrf = (reply.json as { csrfToken?: string } | null)?.csrfToken ?? null
    return reply.json
  }
}

interface CheckResult {
  name: string
  ok: boolean
  detail?: string
}

async function check(name: string, run: () => Promise<string | undefined>): Promise<CheckResult> {
  try {
    const failure = await run()
    return failure ? { name, ok: false, detail: failure } : { name, ok: true }
  } catch (error) {
    return { name, ok: false, detail: error instanceof Refused ? error.message : errorName(error) }
  }
}

// The cluster's system identifier and the database's name: different for every restored copy in a new
// container, and, in one cluster (the tests), different for every database.
export async function databaseIdentity(pool: Pool): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `select system_identifier::text || '/' || current_database() as id from pg_control_system()`,
  )
  return r.rows[0]?.id as string
}

async function brandId(pool: Pool, slug: string): Promise<string | null> {
  const r = await pool.query<{ id: string }>('select id from app.brand where slug = $1', [slug])
  return r.rows[0]?.id ?? null
}

// ---- The probes' database session for the drill: one superuser connection in a transaction that is rolled
// back at the end. Each probe switches to the run-time role (SET LOCAL ROLE, so row-level security and the
// grants apply exactly as they do to that role's own login) inside a savepoint that is rolled back after it.
function savepointAs(client: { query: Pool['query'] }): AsRole {
  return async (role, brand, fn) => {
    await client.query('savepoint probe')
    try {
      await client.query(`set local role mkt_${role}`)
      await client.query("select set_config('app.brand_id', $1, true)", [brand ?? ''])
      return await fn(client as never)
    } finally {
      await client.query('rollback to savepoint probe')
    }
  }
}

async function databaseIsolation(admin: Pool): Promise<string[]> {
  const findings: string[] = []
  const probe = async (label: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (error) {
      findings.push(
        `${label}: ${error instanceof Error && !('code' in error) ? error.message : errorName(error)}`,
      )
    }
  }
  const client = await admin.connect()
  try {
    await client.query('begin')
    const scoped = await brandScopedTables(client)
    // Tests 3 and 4 for every brand-scoped table, from the restored catalog.
    await probe('catalog', () => noPublicFunctions(client))
    await probe('catalog', async () => scopedTablesFound(scoped))
    await probe('catalog', () => rowSecurityForced(client, scoped))
    await probe('catalog', () => brandPolicies(client, scoped))
    await probe('catalog', () => brandIdUniqueKeys(client, scoped))
    await probe('catalog', () => brandIdInForeignKeys(client, scoped))
    const as = savepointAs(client)
    // Test 2 on the restored rows: in every restored brand, each role sees no other brand's rows.
    const restored = await client.query<{ id: string }>('select id from app.brand order by id')
    // A table a role has no read grant on is skipped here (test 5 covers the roles that must have none).
    const readable = await client.query<{ role: 'app' | 'readonly'; t: string }>(
      `select r.role, t from unnest($1::text[]) t, (values ('app'), ('readonly')) r(role)
        where has_table_privilege('mkt_' || r.role, 'app.' || quote_ident(t), 'select')`,
      [scoped],
    )
    for (const { id } of restored.rows) {
      for (const { role, t } of readable.rows) {
        await probe(`test 2, restored ${t} as ${role}`, () => seesOnlyOwnBrand(as, role, id, t))
      }
    }
    // Two probe brands, seeded as the suites seed them, so every rule is exercised whatever the backup holds.
    const a = randomUUID()
    const b = randomUUID()
    const suffix = randomBytes(4).toString('hex')
    await seedProbeBrand(client, a, `restore-probe-a-${suffix}`)
    await seedProbeBrand(client, b, `restore-probe-b-${suffix}`)
    await client.query("select set_config('app.brand_id', '', true)")
    for (const table of SEEDED) {
      await probe(`test 2, ${table}`, async () => {
        await seesOwnBrandRows(as, 'app', a, table)
        await seesOwnBrandRows(as, 'readonly', b, table)
        await seesNothingWithoutBrand(as, table)
      })
    }
    await probe('test 2, brand table', () => brandTableShowsOnlyOwn(as, a))
    await probe('test 5', () => serviceRolesReadNoBusinessTable(as, a))
    await probe('test 3', async () => {
      await refusesInsertForOtherBrand(as, a, b)
      await refusesUpdateToOtherBrand(as, a, b)
      await refusesInsertWithoutBrand(as, a)
      await appRoleCannotDisableSecurity(as, a)
    })
    await probe('test 4', () => refusesCrossBrandParent(as, a, b))
  } finally {
    await client.query('rollback').catch(() => undefined)
    client.release()
  }
  return findings
}

// The core's route table, built the way the running core builds it (with the work engine and the daily
// duties, so every route is declared); nothing is served from it.
function declaredRoutes(coreEnv: Record<string, string>, pools: Pool[], queue: Queue): ProbeRoute[] {
  const config = loadConfig(coreEnv)
  const [appPool, authPool, ownerViewPool, auditPool] = pools as [Pool, Pool, Pool, Pool]
  const audit = new DbAudit(auditPool)
  const { routes } = buildCore({
    config,
    logger: createLogger('silent'),
    appPool,
    authPool,
    mailer: { send: async () => ({ providerId: 'none' }) },
    audit,
    jobs: jobsDeps(appPool, queue, audit, config.workerSecret, config.attemptTokenSecret),
    daily: { ownerViewPool, auditWriterPool: auditPool, store: null, fx: new StandInFxSource(83_000_000n) },
    authLogger: { disabled: true },
  })
  return brandScopedRoutes(routes)
}

function jobsDeps(
  pool: Pool,
  queue: Queue,
  audit: DbAudit,
  workerSecret: string,
  attemptTokenSecret: string,
): JobsDeps {
  return {
    pool,
    queue,
    audit,
    workerSecret,
    attemptTokenSecret,
    backlogLimit: 2000,
    now: () => new Date(),
    results: new Map(),
  }
}

export async function restoreCheck(target: string, env: Env): Promise<CheckResult[]> {
  const roles = required(env, Object.values(ROLE_PASSWORDS))
  const secrets = required(env, [...CORE_SECRETS, 'PUBLIC_ORIGIN'])
  const drill = required(env, DRILL_VARS)
  required(env, ['PGPASSWORD'])
  const url = (role: keyof typeof ROLE_PASSWORDS) =>
    roleUrl(target, role, roles[ROLE_PASSWORDS[role]] as string)
  if (new URL(target).hostname === LIVE_HOST) {
    throw new Refused('the target is the live database service; restore into a throw-away container')
  }
  // Before anything starts: the live database itself is refused, whatever address reaches it. A copy restored
  // into a new container has a new cluster identifier.
  const probe = createPool(target, { max: 1 })
  try {
    if ((await databaseIdentity(probe)) === drill.RESTORE_DRILL_LIVE_DATABASE) {
      throw new Refused('the target is the live database the drill was seeded on, not a restored copy')
    }
  } finally {
    await probe.end()
  }

  const port = await freePort()
  const coreUrl = `http://127.0.0.1:${port}`
  const coreEnv: Record<string, string> = {
    NODE_ENV: 'production',
    PORT: String(port),
    DATABASE_URL: url('app'),
    AUDIT_DATABASE_URL: url('audit_writer'),
    QUEUE_DATABASE_URL: url('queue'),
    OWNER_VIEW_DATABASE_URL: url('owner_view'),
    ...Object.fromEntries(CORE_SECRETS.map((name) => [name, secrets[name] as string])),
    PUBLIC_ORIGIN: secrets.PUBLIC_ORIGIN as string,
    // No proxy in front; no mail, error reporting or audit store: the drill reaches nothing outside the copy.
    TRUST_PROXY: '0',
    LOG_LEVEL: 'silent',
    N8N_HEARTBEAT_EXPECTED: 'false',
  }
  const origin = new URL(coreEnv.PUBLIC_ORIGIN as string).origin

  const admin = createPool(target, { max: 3 })
  const ownerView = createPool(url('owner_view'), { max: 2 })
  let core: ChildProcess | null = null
  let worker: ChildProcess | null = null
  const results: CheckResult[] = []
  const session = new Session(coreUrl, origin)
  let signedIn = false
  try {
    const job = await admin.query<{ state: string; run_id: string; brand_id: string }>(
      `select q.state, i.run_id, i.brand_id from pgboss.job q join app.job_input i on i.job_id = q.id where q.id = $1`,
      [drill.RESTORE_DRILL_JOB_ID],
    )
    const waiting = job.rows[0]

    core = startChild(CORE_MAIN, coreEnv)
    const coreFailure = await until(60_000, async () => {
      if (core?.exitCode !== null) throw new Refused(`the core exited with code ${core?.exitCode}`)
      const res = await fetch(`${coreUrl}/api/health/ready`).catch(() => null)
      return res?.status === 200
    }).then(
      () => undefined,
      (error: unknown) => (error instanceof Refused ? error.message : 'the core was not ready in 60 s'),
    )

    // 1. Password and second factor, through the core.
    results.push(
      await check('sign-in with password and second factor', async () => {
        if (coreFailure) return coreFailure
        const first = await session.request('POST', '/api/auth/sign-in/email', {
          email: drill.RESTORE_DRILL_EMAIL,
          password: drill.RESTORE_DRILL_PASSWORD,
        })
        if (first.status !== 200) return `the password step answered ${first.status}`
        if ((first.json as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect !== true) {
          return 'the second factor was not asked for'
        }
        const second = await session.request('POST', '/api/auth/two-factor/verify-totp', {
          code: totp(drill.RESTORE_DRILL_TOTP_SECRET as string),
        })
        if (second.status !== 200) return `the second-factor step answered ${second.status}`
        const me = (await session.refreshCsrf()) as {
          user?: { email?: string }
          twoFactorEnabled?: boolean
        } | null
        if (me?.user?.email !== drill.RESTORE_DRILL_EMAIL || me?.twoFactorEnabled !== true) {
          return 'the session does not show the drill user with the second factor'
        }
        signedIn = true
        return undefined
      }),
    )

    // 2. The job that waited in the backup is claimed by a worker started now, and its run succeeds.
    results.push(
      await check('a job waiting in the backup finishes after a worker starts', async () => {
        if (coreFailure) return coreFailure
        if (!waiting) return 'the drill job is not in the restored queue'
        if (waiting.state !== 'created')
          return `the drill job was ${waiting.state} in the backup, not waiting`
        worker = startChild(WORKER_MAIN, {
          // The stand-in model, which the worker accepts only under NODE_ENV=test: no provider is called.
          NODE_ENV: 'test',
          MODEL_BACKEND: 'standin',
          CORE_URL: coreUrl,
          WORKER_SECRET: secrets.WORKER_SECRET as string,
          QUEUE_DATABASE_URL: url('queue'),
          WORKER_ID: 'restore-drill',
        })
        let state = ''
        try {
          await until(180_000, async () => {
            if (worker?.exitCode !== null)
              throw new Refused(`the worker exited with code ${worker?.exitCode}`)
            const r = await admin.query<{ state: string }>('select state from app.run where id = $1', [
              waiting.run_id,
            ])
            state = r.rows[0]?.state ?? 'missing'
            if (state === 'failed' || state === 'cancelled') throw new Refused(`the drill run ended ${state}`)
            return state === 'succeeded'
          })
        } catch (error) {
          if (error instanceof Refused) return error.message
          return `the drill run was still ${state} after 180 s`
        }
        const claimed = await admin.query<{ state: string }>('select state from pgboss.job where id = $1', [
          drill.RESTORE_DRILL_JOB_ID,
        ])
        if (claimed.rows[0]?.state !== 'completed') return `the drill job is ${claimed.rows[0]?.state}`
        return undefined
      }),
    )
    // Test 6 below makes jobs of its own; no worker may take them.
    await stopChild(worker)

    // 3. Every audit chain.
    results.push(
      await check('audit chains verify', async () => {
        const result = await verifyAudit({ reader: ownerView, store: null })
        if (result.chains === 0) return 'no audit chain in the restored database'
        if (!result.ok) {
          const kinds = [...new Set(result.findings.map((f) => f.kind))].join(', ')
          return `${result.findings.length} finding(s) (${kinds}) in ${result.chains} chain(s)`
        }
        return undefined
      }),
    )

    // 4. Tenant isolation, tests 1 to 6.
    results.push(
      await check('isolation tests 1 to 6', async () => {
        const findings = (await databaseIsolation(admin)).map((f) => `tests 2-5 ${f}`)
        const own = await brandId(admin, DRILL_BRANDS.own)
        const other = await brandId(admin, DRILL_BRANDS.other)
        const blocked =
          !own || !other
            ? 'the drill brands are not in the restored database'
            : (coreFailure ??
              (signedIn ? null : 'tests 1 and 6 need the drill user signed in (check 1 failed)'))
        if (blocked) findings.push(blocked)
        else if (own && other) {
          const pools = [
            createPool(url('app'), { max: 2 }),
            createPool(url('app'), { searchPath: 'auth', max: 2 }),
            createPool(url('owner_view'), { max: 2 }),
            createPool(url('audit_writer'), { max: 2 }),
          ]
          const queue = await openQueue(target)
          try {
            // Test 1: as the drill user (a brand admin in the drill's own brand only), every brand-scoped route
            // answers 404 for the other drill brand; the reads answer in the own brand, so the 404s mean something.
            const routes = declaredRoutes(coreEnv, pools, queue)
            const ids = async (brand: string) => {
              const r = await admin.query<{ item: string | null; run: string | null }>(
                `select (select id from app.content_item where brand_id = $1 limit 1) as item,
                      (select id from app.run where brand_id = $1 limit 1) as run`,
                [brand],
              )
              return r.rows[0] ?? { item: null, run: null }
            }
            const fillFor =
              (brand: string, rows: { item: string | null; run: string | null }) => (path: string) =>
                path
                  .replace(':brandId', brand)
                  .replace(':itemId', rows.item ?? NO_ROW)
                  .replace(':runId', rows.run ?? NO_ROW)
                  .replace(/:[a-zA-Z]+/g, NO_ROW)
            const request = (method: string, path: string, body: unknown) =>
              session.request(method, path, body)
            if (routes.length < 5) findings.push(`test 1: only ${routes.length} brand-scoped routes`)
            findings.push(
              ...(await otherBrandFindings(routes, request, fillFor(other, await ids(other)), other)).map(
                (f) => `test 1 ${f}`,
              ),
              // Reads only: a write in the own brand would change the copy the later probes read.
              ...(
                await ownBrandFindings(
                  routes.filter((r) => r.method === 'get'),
                  request,
                  fillFor(own, await ids(own)),
                )
              ).map((f) => `test 1 control ${f}`),
            )

            // Test 6: three new jobs (two in the drill's own brand, one in the other), a real attempt started
            // for the first, and its token used on the other two.
            const audit = new DbAudit(admin)
            const deps = jobsDeps(admin, queue, audit, secrets.WORKER_SECRET as string, '')
            const actor = await admin.query<{ id: string }>('select id from auth."user" where email = $1', [
              drill.RESTORE_DRILL_EMAIL,
            ])
            const start = (brand: string) =>
              startSummaryRun(admin, deps, {
                brandId: brand,
                brief: DRILL_BRIEF,
                actor: { userId: actor.rows[0]?.id ?? NO_ROW },
              })
            const [first, sameBrand, otherBrand] = [await start(own), await start(own), await start(other)]
            await admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
              first.jobId,
            ])
            const auth = { authorization: `Worker ${secrets.WORKER_SECRET}` }
            const started = await fetch(`${coreUrl}/api/v1/worker/jobs/${first.jobId}/attempts`, {
              method: 'POST',
              headers: { ...auth, 'content-type': 'application/json' },
              body: JSON.stringify({ workerId: 'restore-drill' }),
            })
            const token = ((await started.json().catch(() => null)) as { token?: string } | null)?.token
            if (started.status !== 200 || !token) {
              findings.push(`test 6: starting an attempt answered ${started.status}`)
            } else {
              const tokenRequest = async (path: string, value: string) => {
                const res = await fetch(`${coreUrl}${path}`, {
                  headers: { ...auth, 'x-attempt-token': value },
                })
                return { status: res.status, text: await res.text() }
              }
              findings.push(
                ...(
                  await attemptTokenFindings(
                    tokenRequest,
                    token,
                    first.jobId,
                    [
                      { jobId: sameBrand.jobId, label: 'same brand' },
                      { jobId: otherBrand.jobId, label: 'other brand' },
                    ],
                    other,
                  )
                ).map((f) => `test 6 ${f}`),
              )
            }
          } finally {
            await queue.stop()
            await Promise.all(pools.map((pool) => pool.end()))
          }
        }
        if (findings.length === 0) return undefined
        // The first ten, so one broken rule does not bury the line.
        const more = findings.length > 10 ? `; and ${findings.length - 10} more` : ''
        return `${findings.length} finding(s): ${findings.slice(0, 10).join('; ')}${more}`
      }),
    )
  } finally {
    await stopChild(worker)
    await stopChild(core)
    await admin.end()
    await ownerView.end()
  }
  return results
}

async function until(ms: number, done: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + ms
  while (!(await done())) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(500)
  }
}

// ---- seed

async function authRequest(
  auth: ReturnType<typeof createAuth>,
  origin: string,
  cookies: Map<string, string>,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const headers: Record<string, string> = { origin, 'content-type': 'application/json' }
  if (cookies.size > 0) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  const res = await auth.handler(
    new Request(`${origin}/api/auth${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  )
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(';')[0] ?? ''
    const at = pair.indexOf('=')
    cookies.set(pair.slice(0, at), pair.slice(at + 1))
  }
  const text = await res.text()
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null }
}

// The drill file: NAME=value lines, root's, 0600. A new one is never written over an old one ('wx').
function writeDrillFile(file: string, lines: Record<string, string>, flag: 'w' | 'wx'): void {
  const text = Object.entries(lines)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  writeFileSync(file, `${text}\n`, { mode: 0o600, flag })
}

export function parseDrillFile(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
}

export async function seedDrill(target: string, env: Env): Promise<{ jobId: string }> {
  const {
    AUTH_SECRET: secret,
    PUBLIC_ORIGIN: publicOrigin,
    RESTORE_DRILL_FILE: file,
  } = required(env, ['AUTH_SECRET', 'PUBLIC_ORIGIN', 'RESTORE_DRILL_FILE', 'PGPASSWORD'])
  const origin = new URL(publicOrigin as string).origin
  const pool = createPool(target, { max: 2 })
  const authPool = createPool(target, { searchPath: 'auth', max: 2 })
  const queue = await openQueue(target)
  try {
    const existing = await pool.query<{ id: string }>('select id from auth."user" where email = $1', [
      DRILL_EMAIL,
    ])
    const drillUser = existing.rows[0]?.id
    if (drillUser) {
      // A later drill: the drill user and its file exist. Only a new waiting job is made, and the file's job id
      // is replaced.
      let lines: Record<string, string>
      try {
        lines = parseDrillFile(readFileSync(file as string, 'utf8'))
      } catch {
        throw new Refused('the drill user exists and its drill file cannot be read')
      }
      if (!DRILL_ACCOUNT.every((name) => lines[name])) throw new Refused('the drill file is incomplete')
      const own = await brandId(pool, DRILL_BRANDS.own)
      if (!own) throw new Refused('the drill user exists without its brand')
      const { jobId } = await startSummaryRun(pool, jobsDeps(pool, queue, new DbAudit(pool), '', ''), {
        brandId: own,
        brief: DRILL_BRIEF,
        actor: { userId: drillUser },
      })
      writeDrillFile(
        file as string,
        { ...lines, RESTORE_DRILL_JOB_ID: jobId, RESTORE_DRILL_LIVE_DATABASE: await databaseIdentity(pool) },
        'w',
      )
      return { jobId }
    }
    const brands: Record<string, string> = {}
    for (const slug of Object.values(DRILL_BRANDS)) {
      await pool.query(
        `select app.create_brand($1, $1) where not exists (select 1 from app.brand where slug = $1)`,
        [slug],
      )
      brands[slug] = (await brandId(pool, slug)) as string
    }
    const audit = new DbAudit(pool)
    const auth = createAuth({
      pool: authPool,
      secret: secret as string,
      baseURL: origin,
      mailer: {
        send: async () => {
          throw new Error('the drill seed sends no mail')
        },
      },
      audit,
      limiter: new AttemptLimiter({
        maxFailures: LOCK_MAX_FAILURES,
        windowMs: LOCK_WINDOW_MS,
        lockMs: LOCK_DURATION_MS,
      }),
      logger: { disabled: true },
    })
    const password = randomBytes(18).toString('base64url')
    const { id: userId } = await createUserWithPassword(auth, {
      email: DRILL_EMAIL,
      name: 'restore drill',
      password,
    })
    await pool.query(
      `insert into app.membership (brand_id, user_id, role, created_by) values ($1, $2, 'brand_admin', $2)`,
      [brands[DRILL_BRANDS.own], userId],
    )
    // Enrolment, as at a first sign-in: the library stores the secret encrypted with AUTH_SECRET.
    const cookies = new Map<string, string>()
    const signIn = await authRequest(auth, origin, cookies, '/sign-in/email', {
      email: DRILL_EMAIL,
      password,
    })
    if (signIn.status !== 200) throw new Refused(`the drill user's sign-in answered ${signIn.status}`)
    const enable = await authRequest(auth, origin, cookies, '/two-factor/enable', { password })
    const uri = typeof enable.json?.totpURI === 'string' ? enable.json.totpURI : ''
    const totpSecret = uri ? new URL(uri).searchParams.get('secret') : null
    if (enable.status !== 200 || !totpSecret)
      throw new Refused(`enabling the second factor answered ${enable.status}`)
    const verify = await authRequest(auth, origin, cookies, '/two-factor/verify-totp', {
      code: totp(totpSecret),
    })
    if (verify.status !== 200) throw new Refused(`confirming the second factor answered ${verify.status}`)

    for (const slug of Object.values(DRILL_BRANDS)) {
      await pool.query(`insert into app.content_item (brand_id, kind) values ($1, 'article')`, [brands[slug]])
    }
    const { jobId } = await startSummaryRun(pool, jobsDeps(pool, queue, audit, '', ''), {
      brandId: brands[DRILL_BRANDS.own] as string,
      brief: DRILL_BRIEF,
      actor: { userId },
    })
    writeDrillFile(
      file as string,
      {
        RESTORE_DRILL_EMAIL: DRILL_EMAIL,
        RESTORE_DRILL_PASSWORD: password,
        RESTORE_DRILL_TOTP_SECRET: totpSecret,
        RESTORE_DRILL_JOB_ID: jobId,
        RESTORE_DRILL_LIVE_DATABASE: await databaseIdentity(pool),
      },
      'wx',
    )
    return { jobId }
  } finally {
    await queue.stop()
    await pool.end()
    await authPool.end()
  }
}

// ---- cancel-live and unseed, on the live database

// Every drill job not yet finished on the live database, in either drill brand.
async function openDrillJobs(
  pool: Pool,
): Promise<{ job_id: string; class: string; run_id: string; brand_id: string }[]> {
  const r = await pool.query<{ job_id: string; class: string; run_id: string; brand_id: string }>(
    `select i.job_id, i.class, i.run_id, i.brand_id
       from app.job_input i
       join app.job_control c on c.brand_id = i.brand_id and c.job_id = i.job_id
       join app.brand b on b.id = i.brand_id
      where b.slug = any($1) and i.finished_at is null and not c.cancel_requested`,
    [Object.values(DRILL_BRANDS)],
  )
  return r.rows
}

// After the backup that holds the drill has been taken, and before the live worker starts again: the drill's
// waiting jobs are cancelled on the live database (the queue's job, the job's control and its run, with an
// audit entry, as the dead-job cancel does), so no worker ever sends the drill's brief to the model. The copy
// in the backup keeps them waiting.
export async function cancelLiveDrill(target: string, env: Env): Promise<{ cancelled: number }> {
  required(env, ['PGPASSWORD'])
  const pool = createPool(target, { max: 2 })
  const queue = await openQueue(target)
  try {
    const user = await pool.query<{ id: string }>('select id from auth."user" where email = $1', [
      DRILL_EMAIL,
    ])
    const actor = user.rows[0]?.id ?? null
    const audit = new DbAudit(pool)
    const jobs = await openDrillJobs(pool)
    for (const job of jobs) {
      await withBrand(pool, job.brand_id, async (client) => {
        await queue.cancel(job.class as JobClass, job.job_id, await currentQueueId(client, job.job_id))
        await client.query(
          'update app.job_control set cancel_requested = true, updated_at = now() where job_id = $1',
          [job.job_id],
        )
        await finaliseRun(client, job.run_id)
        await audit.record(
          {
            action: 'jobs.cancelled',
            actor,
            brandId: job.brand_id,
            subject: job.job_id,
            outcome: 'success',
            detail: { jobId: job.job_id, reason: 'restore_drill' },
          },
          client,
        )
      })
    }
    return { cancelled: jobs.length }
  } finally {
    await queue.stop()
    await pool.end()
  }
}

// When the drill file is lost: the drill's open jobs are cancelled and the drill user removed (its sessions,
// password and second factor go with it), so a new seed can start over. The drill brands and their rows stay.
export async function unseedDrill(
  target: string,
  env: Env,
): Promise<{ removed: boolean; cancelled: number }> {
  const { cancelled } = await cancelLiveDrill(target, env)
  const pool = createPool(target, { max: 1 })
  try {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(
        `delete from app.membership where user_id in (select id from auth."user" where email = $1)`,
        [DRILL_EMAIL],
      )
      const removed = await client.query('delete from auth."user" where email = $1', [DRILL_EMAIL])
      await client.query('commit')
      return { removed: removed.rowCount === 1, cancelled }
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

if (import.meta.main) {
  const [first, ...rest] = process.argv.slice(2)
  const command = first === 'seed' || first === 'cancel-live' || first === 'unseed' ? first : null
  const args = command ? rest : process.argv.slice(2)
  const event = command ? `restore_drill_${command.replace('-', '_')}` : 'restore_check'
  try {
    const target = parseTarget(args)
    if (command === 'seed') {
      await seedDrill(target, process.env)
      process.stdout.write(`${JSON.stringify({ event: 'restore_drill_seeded' })}\n`)
    } else if (command === 'cancel-live') {
      const { cancelled } = await cancelLiveDrill(target, process.env)
      process.stdout.write(`${JSON.stringify({ event: 'restore_drill_cancelled', jobs: cancelled })}\n`)
    } else if (command === 'unseed') {
      const done = await unseedDrill(target, process.env)
      process.stdout.write(`${JSON.stringify({ event: 'restore_drill_unseeded', ...done })}\n`)
    } else {
      const results = await restoreCheck(target, process.env)
      for (const r of results) {
        process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? `: ${r.detail}` : ''}\n`)
      }
      process.exitCode = results.every((r) => r.ok) ? 0 : 1
    }
  } catch (error) {
    if (error instanceof Refused) {
      process.stderr.write(`${JSON.stringify({ event: `${event}_refused`, reason: error.message })}\n`)
      process.exitCode = 2
    } else {
      process.stderr.write(`${JSON.stringify({ event: `${event}_failed`, error: errorName(error) })}\n`)
      process.exitCode = 1
    }
  }
}
