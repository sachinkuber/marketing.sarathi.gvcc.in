// The stack the browser checks run against, started by Playwright (`webServer` in ../playwright.config.ts):
//
//   a throw-away database  ->  the core (buildCore, the real routes)  ->  a worker in this process with the
//   stand-in model  ->  `next build` and `next start` of the dashboard, which forwards /api to the core.
//
// The core's PUBLIC_ORIGIN is the dashboard's address, so the browser only ever talks to one origin and the
// core's origin check holds unchanged. Time is a clock this file owns: the core's reminders, escalation and
// overdue marking read it, and the test-only route POST /test/clock (which exists in this harness only, never
// in main.ts) moves it and runs the approvals tick. A small control server, on its own port, lets the specs
// seed brands, users and items, compute authenticator codes (`totp`) and expire a session.
//
// Run natively (`node e2e/stack.ts`), like the production entry points: it prints nothing a spec depends on,
// and answers GET /health on the control port once everything is up.
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { createPool, withBrand } from '@mkt/db'
import type { TestDatabase } from '@mkt/db/testing'
import { openQueue } from '@mkt/queue'
import { createQueueTestDatabase } from '@mkt/queue/testing'
import { requireDatabase } from '@mkt/test-support'
import { registerSummaryHandlers } from '../../core/src/agents/register.ts'
import { tick } from '../../core/src/approvals/requests.ts'
import { DbAudit } from '../../core/src/audit/db-audit.ts'
import { AttemptLimiter } from '../../core/src/auth/limiter.ts'
import { LOCK_DURATION_MS, LOCK_MAX_FAILURES, LOCK_WINDOW_MS } from '../../core/src/auth/policy.ts'
import type { Config } from '../../core/src/config.ts'
import { createVersion, moveState } from '../../core/src/content/versions.ts'
import { buildCore } from '../../core/src/core.ts'
import { createLogger } from '../../core/src/logger.ts'
import type { Clock } from '../../core/src/notify/ports.ts'
import type { Mailer, MailMessage, SendReceipt } from '../../core/src/ports.ts'
import type { JobsDeps } from '../../core/src/jobs/service.ts'
import type { ResultHandlers } from '../../core/src/jobs/results.ts'
import { addBrand, addUser, enrol, TestClient, totp } from '../../core/test/support.ts'
import { checkHandler } from '../../worker/src/agents/check.ts'
import { summaryHandler } from '../../worker/src/agents/summary.ts'
import { httpCoreClient } from '../../worker/src/core-client.ts'
import { startWorker } from '../../worker/src/main.ts'
import { standInModel } from '../../worker/src/standin.ts'

export const PASSWORD = 'correct horse battery'
const HOUR = 3_600_000
// What the stand-in model answers for the summary agent: a valid summary (the core checks it strictly).
const MODEL_REPLY = JSON.stringify({
  summary: 'A short, friendly summary.',
  keywords: ['monsoon', 'range', 'launch'],
})

// Ports: the dashboard, then the control server and the core on the next two. Fixed, so a spec and the
// dashboard build know them before the stack is up; E2E_PORT moves all three.
export function ports(env: Record<string, string | undefined> = process.env) {
  const dashboard = Number(env.E2E_PORT ?? 3410)
  return { dashboard, control: dashboard + 1, core: dashboard + 2 }
}

// The clock the core reads: real time plus an offset the harness moves forward. Never backwards.
class HarnessClock implements Clock {
  private offsetMs = 0
  now(): Date {
    return new Date(Date.now() + this.offsetMs)
  }
  advance(ms: number): void {
    this.offsetMs += ms
  }
}

// Every message the core sends, one JSON line each, in a file the specs may read (see readMail).
class FileMailer implements Mailer {
  private count = 0
  private readonly file: string
  constructor(file: string) {
    this.file = file
  }
  async send(message: MailMessage): Promise<SendReceipt> {
    this.count += 1
    await appendFile(this.file, `${JSON.stringify(message)}\n`)
    return { providerId: `file-${this.count}` }
  }
}

export function mailFile(env: Record<string, string | undefined> = process.env): string {
  return join(env.E2E_STATE_DIR ?? join(tmpdir(), 'mkt-e2e'), 'mail.jsonl')
}

const dashboardDir = fileURLToPath(new URL('..', import.meta.url))

function run(command: string, args: string[], env: NodeJS.ProcessEnv, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: dashboardDir, env, stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited with ${code}`))))
  })
}

async function untilUp(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() > end) throw new Error(`${url} did not come up`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

const userBody = z.strictObject({
  email: z.string(),
  role: z.enum(['brand_admin', 'approver', 'sales_contact', 'viewer']).optional(),
  brandId: z.string().optional(),
  platformOwner: z.boolean().optional(),
  // Walk the enrolment (an authenticator secret exists and the second factor is set up).
  enrolled: z.boolean().optional(),
})

export async function startStack(env: Record<string, string | undefined> = process.env) {
  const { dashboard, control, core: corePort } = ports(env)
  const origin = `http://127.0.0.1:${dashboard}`
  const coreUrl = `http://127.0.0.1:${corePort}`
  await mkdir(env.E2E_STATE_DIR ?? join(tmpdir(), 'mkt-e2e'), { recursive: true })

  await requireDatabase()
  const db: TestDatabase = await createQueueTestDatabase()
  const appPool = createPool(db.urlFor('app'))
  const authPool = createPool(db.urlFor('app'), { searchPath: 'auth' })
  const auditPool = createPool(db.urlFor('audit_writer'))
  const ownerViewPool = createPool(db.urlFor('owner_view'))
  const audit = new DbAudit(auditPool)
  const queue = await openQueue(db.urlFor('queue'))
  const clock = new HarnessClock()
  const config: Config = {
    nodeEnv: 'test',
    port: corePort,
    databaseUrl: db.urlFor('app'),
    auditDatabaseUrl: db.urlFor('audit_writer'),
    ownerViewDatabaseUrl: db.urlFor('owner_view'),
    queueDatabaseUrl: db.urlFor('queue'),
    authSecret: 'e2e-auth-secret-'.padEnd(48, 'x'),
    workerSecret: 'e2e-worker-secret-'.padEnd(48, 'w'),
    attemptTokenSecret: 'e2e-attempt-secret-'.padEnd(48, 'a'),
    triggerSecret: 'e2e-trigger-secret-'.padEnd(48, 't'),
    queueBacklogLimit: 2000,
    publicOrigin: origin,
    n8nHeartbeatExpected: false,
    logLevel: 'silent',
  }
  const results: ResultHandlers = new Map()
  const jobs: JobsDeps = {
    pool: appPool,
    queue,
    audit,
    workerSecret: config.workerSecret,
    attemptTokenSecret: config.attemptTokenSecret,
    backlogLimit: config.queueBacklogLimit,
    // Job tokens and timeouts run on real time; only the approvals' reminders follow the harness clock.
    now: () => new Date(),
    results,
  }
  registerSummaryHandlers(results, jobs)
  // A price and a rate, so the run shows a cost in both currencies (the same figures as the worker's test).
  const today = new Date().toISOString().slice(0, 10)
  await db.admin.query(
    `insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, source)
     values ('claude-opus-5-5', $1::date - 30, 4000000, 20000000, 200000, 5000000, 'e2e')`,
    [today],
  )
  await db.admin.query(`select app.record_fx_rate($1::date - 1, 83500000, 'e2e')`, [today])

  const core = buildCore({
    config,
    logger: createLogger('warn'),
    appPool,
    authPool,
    mailer: new FileMailer(mailFile(env)),
    audit,
    jobs,
    clock,
    daily: {
      ownerViewPool,
      auditWriterPool: auditPool,
      store: null,
      fx: {
        fetchUsdInr: async (date) => ({ rateDate: date, rateMicros: 83_500_000n, source: 'e2e' }),
      },
    },
    limiter: new AttemptLimiter({
      maxFailures: LOCK_MAX_FAILURES,
      windowMs: LOCK_WINDOW_MS,
      lockMs: LOCK_DURATION_MS,
    }),
    authLogger: { disabled: true },
    extraRoutes: (table) => {
      // Test only: moves the clock, a day at a time, and runs the approvals tick after each day, as the
      // worker's timer would have over those days (a tick takes one step per request).
      table.add({
        method: 'post',
        path: '/test/clock',
        access: { kind: 'platform_owner' },
        summary: 'Test harness only: advance the clock by whole hours and run the approvals tick',
        handlers: [
          async (req, res) => {
            const hours = z.object({ hours: z.number().int().min(1).max(1000) }).parse(req.body).hours
            for (let left = hours; left > 0; left -= 24) {
              clock.advance(Math.min(left, 24) * HOUR)
              await tick(appPool, { clock, audit })
            }
            res.json({ now: clock.now().toISOString() })
          },
        ],
      })
    },
  })
  const coreServer = await new Promise<Server>((resolve, reject) => {
    const listening = core.app.listen(corePort, '127.0.0.1', (error?: Error) =>
      error ? reject(error) : resolve(listening),
    )
  })

  const worker = await startWorker({
    core: httpCoreClient(coreUrl, config.workerSecret),
    model: standInModel({ logFile: '/dev/null', replyFor: () => MODEL_REPLY }),
    handlers: { 'summary.v1': summaryHandler, 'placeholder_check.v1': checkHandler },
    queueUrl: db.urlFor('queue'),
    workerId: 'e2e',
    classes: ['interactive'],
    processesPerClass: 1,
    superviseIntervalSeconds: 1,
    log: () => undefined,
  })

  // Users the specs ask for. The seeding helpers are the core tests' own.
  const seed = { core, db }
  const secrets = new Map<string, string>()
  const newClient = () => new TestClient(coreUrl, origin)
  let owner: { client: TestClient; email: string } | null = null
  const ownerClient = async () => {
    if (!owner) {
      const email = 'control@e2e.test'
      await addUser(seed, { email, password: PASSWORD, platformOwner: true })
      owner = { client: newClient(), email }
    }
    // Signs in again whenever the session has gone (an idle half hour).
    const probe = await owner.client.request('GET', '/api/v1/session')
    if (probe.status !== 200 || probe.json?.enrolmentRequired !== false) {
      owner.client = newClient()
      const reply = await owner.client.signIn(owner.email, PASSWORD)
      if (reply.status !== 200) throw new Error(`control sign-in failed: ${reply.status}`)
      if (reply.json?.twoFactorRedirect) {
        const secret = secrets.get(owner.email)
        if (!secret) throw new Error('the control owner has no authenticator')
        const verify = await owner.client.request('POST', '/api/auth/two-factor/verify-totp', {
          body: { code: totp(secret) },
        })
        if (verify.status !== 200) throw new Error(`control code failed: ${verify.status}`)
        await owner.client.refreshCsrf()
      } else {
        const { secret } = await enrol(owner.client, PASSWORD)
        secrets.set(owner.email, secret)
      }
    }
    return owner.client
  }

  const handlers: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    'POST /brand': async (body) => ({ brandId: await addBrand({ db }, String(body.slug)) }),
    'POST /user': async (raw) => {
      const body = userBody.parse(raw)
      const id = await addUser(seed, { ...body, password: PASSWORD })
      let secret: string | null = null
      if (body.enrolled) {
        const client = newClient()
        const reply = await client.signIn(body.email, PASSWORD)
        if (reply.status !== 200) throw new Error(`seed sign-in failed: ${reply.status}`)
        secret = (await enrol(client, PASSWORD)).secret
        secrets.set(body.email, secret)
      }
      return { id, secret }
    },
    // An item waiting for approval, made by the platform as an agent would (version, checks skipped).
    'POST /item': async (body) => {
      const brandId = String(body.brandId)
      const { rows } = await db.admin.query(
        `insert into app.content_item (brand_id, kind) values ($1, 'article') returning id`,
        [brandId],
      )
      const itemId = rows[0].id as string
      const actor = { kind: 'system' as const }
      const made = await withBrand(appPool, brandId, async (client) => {
        const version = await createVersion(
          client,
          { audit },
          {
            brandId,
            contentItemId: itemId,
            payload: {
              kind: 'article',
              language: 'en',
              title: String(body.title),
              body: [{ type: 'paragraph', text: `Text of ${String(body.title)}` }],
            },
            createdBy: actor,
          },
        )
        await moveState(client, { audit }, version.versionId, 'in_checks', actor)
        await moveState(client, { audit }, version.versionId, 'awaiting_approval', actor)
        return version
      })
      return { itemId, versionId: made.versionId }
    },
    'POST /clock': async (body) => {
      const client = await ownerClient()
      const reply = await client.request('POST', '/api/v1/test/clock', { body: { hours: body.hours } })
      if (reply.status !== 200) throw new Error(`clock failed: ${reply.status} ${reply.text}`)
      return reply.json
    },
    // The code an authenticator app would show now. Near the end of a 30-second step it waits for the next,
    // so a code is never checked after it has run out.
    'POST /code': async (body) => {
      const secret = String(body.secret)
      const left = 30_000 - (Date.now() % 30_000)
      if (left < 3_000) await new Promise((resolve) => setTimeout(resolve, left + 100))
      return { code: totp(secret) }
    },
    // Ends every session of a person on the server, as the idle timeout does.
    'POST /expire-sessions': async (body) => {
      const { rowCount } = await db.admin.query(
        `update auth.session set "expiresAt" = now() - interval '1 minute'
          where "userId" = (select id from auth."user" where email = $1)`,
        [String(body.email).toLowerCase()],
      )
      return { expired: rowCount }
    },
  }

  const controlServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://control.invalid')
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(json))
    }
    if (url.pathname === '/health') return send(ready ? 200 : 503, { ok: ready })
    const handler = handlers[`${req.method} ${url.pathname}`]
    if (!handler) return send(404, { error: 'no such control route' })
    readJson(req)
      .then((body) => handler(body as Record<string, unknown>))
      .then((json) => send(200, json))
      .catch((error: unknown) => send(500, { error: error instanceof Error ? error.message : 'failed' }))
  })
  let ready = false
  await new Promise<void>((resolve) => controlServer.listen(control, '127.0.0.1', resolve))

  // The dashboard: built for this core address (Next.js compiles the /api rewrite into the build), then served.
  // E2E_REUSE_BUILD=1 skips the build when one exists, for quick reruns while writing specs.
  const nodeEnv = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' }
  const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next', { paths: [dashboardDir] })
  const dashboardEnv = { ...nodeEnv, CORE_INTERNAL_URL: coreUrl }
  if (env.E2E_REUSE_BUILD !== '1') await run(process.execPath, [nextBin, 'build'], dashboardEnv, 'next build')
  const next: ChildProcess = spawn(
    process.execPath,
    [nextBin, 'start', '-H', '127.0.0.1', '-p', String(dashboard)],
    { cwd: dashboardDir, env: dashboardEnv, stdio: ['ignore', 'inherit', 'inherit'] },
  )
  await untilUp(`${origin}/sign-in`, 60_000)
  ready = true

  return {
    origin,
    async stop() {
      next.kill('SIGTERM')
      await worker.stop()
      await new Promise<void>((resolve) => controlServer.close(() => resolve()))
      controlServer.closeAllConnections()
      await new Promise<void>((resolve) => coreServer.close(() => resolve()))
      coreServer.closeAllConnections()
      await queue.stop()
      await Promise.all([appPool.end(), authPool.end(), auditPool.end(), ownerViewPool.end()])
      await db.drop()
    },
  }
}

if (import.meta.main) {
  const stack = await startStack()
  console.log(`e2e stack up: ${stack.origin}`)
  let stopping = false
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) return
      stopping = true
      stack.stop().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error('The e2e stack did not stop cleanly.', error)
          process.exit(1)
        },
      )
    })
  }
}
