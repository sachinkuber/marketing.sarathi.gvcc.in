import { createPool, type Pool } from '@mkt/db'
import { openQueue } from '@mkt/queue'
import { startSummaryRun } from './agents/start.ts'
import { DbAudit } from './audit/db-audit.ts'
import type { JobsDeps } from './jobs/service.ts'
import { errorName } from './notify/ports.ts'

// The load-test injector (spec 17, test 41; controller ruling R22). It makes production-class summary runs
// through the product's own run and job creation (startSummaryRun: the run, the job input, its control row,
// the queue send and the audit entry in one transaction), spread evenly over the window less its last 60 s
// (ruling R23), alternating brands.
// Test only, and refused unless BOTH --load-test is given and every brand's slug starts with `load-test-`;
// those brands are created when missing. No other brand is ever touched.
//
// Run in the core container, which has this code and reaches the database (tools/load/run.mjs does this):
//   docker exec -i -e ADMIN_DATABASE_URL <core container> node apps/core/src/load-inject.ts \
//     --load-test --brands load-test-a,load-test-b --jobs 300 --minutes 30
// ADMIN_DATABASE_URL is the superuser's address (postgres.env), from the environment only, never an argument.
// `--jobs 0` only makes the brands. Each job made is one JSON line on stdout
// ({"event":"load_job","n","brand","runId","jobId"}); errors are reported by name only.

const LOAD_BRAND = /^load-test-[a-z0-9][a-z0-9-]{0,40}$/
const BRIEF = (n: number) => `Load test production job ${n}: the monsoon range, two lines, friendly tone.`

export interface InjectOptions {
  loadTest: boolean
  brands: string[]
  jobs: number
  minutes: number
}

class Refused extends Error {}

function whole(value: string | undefined, what: string, max: number): number {
  if (!/^\d+$/.test(value ?? '') || Number(value) > max) {
    throw new Refused(`${what} must be a whole number from 0 to ${max}`)
  }
  return Number(value)
}

export function parseInjectArgs(args: string[]): InjectOptions {
  const options: InjectOptions = { loadTest: false, brands: [], jobs: 0, minutes: 0 }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '--load-test') options.loadTest = true
    else if (arg === '--brands') options.brands = (args[(i += 1)] ?? '').split(',').filter(Boolean)
    else if (arg === '--jobs') options.jobs = whole(args[(i += 1)], '--jobs', 10_000)
    else if (arg === '--minutes') options.minutes = whole(args[(i += 1)], '--minutes', 240)
    // Never echoed: a credential pasted here by mistake must not reach a log.
    else
      throw new Refused('unknown argument (usage: --load-test --brands <load-test-...> --jobs N --minutes M)')
  }
  return options
}

export function checkInjectOptions(options: InjectOptions): InjectOptions {
  if (!options.loadTest) throw new Refused('refused: --load-test is required (this makes test jobs)')
  if (options.brands.length === 0) throw new Refused('--brands is missing')
  if (!options.brands.every((slug) => LOAD_BRAND.test(slug))) {
    throw new Refused('refused: every brand must be a load-test brand (slug load-test-...)')
  }
  return options
}

// Ruling R23: the jobs are spread evenly over the window less its last 60 s, so the last is sent at least 60 s
// before the window closes and every job can finish inside the test. The first goes at 0, the last at
// minutes*60 - 60 s; a window of a minute or less sends them all at once. Milliseconds from the start.
const LAST_SEND_MARGIN_MS = 60_000

export function sendOffsets(jobs: number, minutes: number): number[] {
  const span = Math.max(0, minutes * 60_000 - LAST_SEND_MARGIN_MS)
  const gap = jobs > 1 ? span / (jobs - 1) : 0
  return Array.from({ length: jobs }, (_, n) => n * gap)
}

export interface InjectDeps extends Pick<JobsDeps, 'queue' | 'backlogLimit' | 'audit'> {
  // The superuser's pool: it reads brands by slug and creates the load-test brands.
  pool: Pool
}

export async function injectLoad(
  deps: InjectDeps,
  raw: InjectOptions,
  hooks: {
    emit: (event: Record<string, unknown>) => void
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  },
): Promise<{ sent: number; failed: number }> {
  const options = checkInjectOptions(raw)
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = hooks.now ?? Date.now
  const ids = new Map<string, string>()
  for (const slug of options.brands) {
    await deps.pool.query(
      `select app.create_brand($1, $1) where not exists (select 1 from app.brand where slug = $1)`,
      [slug],
    )
    const { rows } = await deps.pool.query<{ id: string }>('select id from app.brand where slug = $1', [slug])
    ids.set(slug, rows[0]!.id)
  }
  const start = now()
  const offsets = sendOffsets(options.jobs, options.minutes)
  let sent = 0
  let failed = 0
  for (let n = 0; n < options.jobs; n += 1) {
    const wait = start + (offsets[n] as number) - now()
    if (wait > 0) await sleep(wait)
    const brand = options.brands[n % options.brands.length] as string
    try {
      const { runId, jobId } = await startSummaryRun(deps.pool, deps, {
        brandId: ids.get(brand) as string,
        brief: BRIEF(n + 1),
        actor: { system: 'load_test' },
        jobClass: 'production',
      })
      sent += 1
      hooks.emit({ event: 'load_job', n: n + 1, brand, runId, jobId })
    } catch (error) {
      failed += 1
      const code = (error as { code?: unknown }).code
      hooks.emit({
        event: 'load_job_failed',
        n: n + 1,
        brand,
        error: typeof code === 'string' ? code : errorName(error),
      })
    }
  }
  return { sent, failed }
}

if (import.meta.main) {
  try {
    const options = checkInjectOptions(parseInjectArgs(process.argv.slice(2)))
    const adminUrl = process.env.ADMIN_DATABASE_URL
    if (!adminUrl) throw new Refused('ADMIN_DATABASE_URL is missing')
    const pool = createPool(adminUrl, { max: 2 })
    const queue = await openQueue(adminUrl)
    try {
      const done = await injectLoad(
        {
          pool,
          queue,
          audit: new DbAudit(pool),
          backlogLimit: Number(process.env.QUEUE_BACKLOG_LIMIT ?? 2000) || 2000,
        },
        options,
        { emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) },
      )
      process.stdout.write(`${JSON.stringify({ event: 'load_done', ...done })}\n`)
    } finally {
      await queue.stop()
      await pool.end()
    }
  } catch (error) {
    // Our refusals name an argument or a rule; anything else is reported by name only.
    process.stderr.write(
      `load-inject failed: ${error instanceof Refused ? error.message : errorName(error)}\n`,
    )
    process.exitCode = 1
  }
}
