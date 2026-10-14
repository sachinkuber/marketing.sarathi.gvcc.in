import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requireDatabase, sleep } from '@mkt/test-support'
import type { TestDatabase } from '@mkt/db/testing'
import { CLASS_SETTINGS } from '../src/classes.ts'
import { openQueue, type Queue } from '../src/queue.ts'
import { createQueueTestDatabase } from '../src/testing.ts'

let db: TestDatabase
let queue: Queue
let app: pg.Pool

beforeEach(async () => {
  await requireDatabase()
  db = await createQueueTestDatabase()
  queue = await openQueue(db.urlFor('queue'))
  app = new pg.Pool({ connectionString: db.urlFor('app') })
})
afterEach(async () => {
  await queue?.stop()
  await app?.end()
  await db?.drop()
})

async function sendMany(
  jobClass: 'production' | 'interactive',
  key: string,
  count: number,
): Promise<string[]> {
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

const PRODUCTION_CAP = CLASS_SETTINGS.production.brandCap
const INTERACTIVE_CAP = CLASS_SETTINGS.interactive.brandCap
const A_BACKLOG = 500

// Counts start and end lines per group and class, naming the groups A and B, for a failure report.
function lineCounts(lines: string[], names: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const line of lines) {
    const [, kind, jobClass, key] = line.split(' ')
    const name = `${names[key ?? ''] ?? 'other'} ${jobClass} ${kind}`
    counts[name] = (counts[name] ?? 0) + 1
  }
  return counts
}

// What the database and the worker processes look like when brand B was not served in time. Printed to
// stderr so a CI log carries it; it never decides the test's outcome.
async function reportStall(input: {
  keyA: string
  keyB: string
  b: string[]
  lines: string[]
  workers: ChildProcess[]
  phases: Record<string, number>
}): Promise<void> {
  const { keyA, keyB, b, lines, workers, phases } = input
  const report: Record<string, unknown> = { phases }
  report.lineCounts = lineCounts(lines, { [keyA]: 'A', [keyB]: 'B' })
  try {
    const bJobs = await db.admin.query(
      `select id, name, state, retry_count, created_on, start_after, started_on, completed_on
         from pgboss.job where id = any($1::uuid[]) order by name, created_on`,
      [b],
    )
    report.bJobs = bJobs.rows
    const aStates = await db.admin.query(
      `select state, count(*)::int as n from pgboss.job where group_id = $1 group by state`,
      [keyA],
    )
    report.aStates = aStates.rows
    const activity = await db.admin.query(
      `select pid, usename, application_name, state, wait_event_type, wait_event,
              now() - query_start as running_for, left(query, 160) as query
         from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`,
    )
    report.activity = activity.rows
    const locks = await db.admin.query(
      `select l.pid, l.locktype, l.mode, l.granted, c.relname
         from pg_locks l left join pg_class c on c.oid = l.relation
        where not l.granted`,
    )
    report.waitingLocks = locks.rows
  } catch (error) {
    report.databaseError = (error as Error).message
  }
  report.workers = workers.map((w) => ({
    pid: w.pid,
    connected: w.connected,
    exitCode: w.exitCode,
    signalCode: w.signalCode,
  }))
  report.bLines = lines.filter((l) => l.includes(keyB))
  report.lastLines = lines.slice(-20)
  console.error(`fairness stall report ${JSON.stringify(report, null, 1)}`)
}

function lineTime(line: string): number {
  return Number(line.split(' ')[0])
}

async function readLines(log: string): Promise<string[]> {
  return (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
}

// Resolves when the worker reports ready; rejects if it exits or errors first, or on timeout.
function whenReady(worker: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('worker did not report ready in time')), timeoutMs)
    const onMessage = (m: unknown): void => {
      if (m === 'ready') done()
    }
    const onExit = (code: number | null, signal: string | null): void =>
      done(new Error(`worker exited before ready (code ${code}, signal ${signal})`))
    const onError = (error: Error): void => done(error)
    function done(error?: Error): void {
      clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('exit', onExit)
      worker.off('error', onError)
      if (error) reject(error)
      else resolve()
    }
    worker.on('message', onMessage)
    worker.on('exit', onExit)
    worker.on('error', onError)
  })
}

for (const processes of [1, 2]) {
  describe(`acceptance test 29 with ${processes} worker process${processes > 1 ? 'es' : ''}`, () => {
    it('never runs more than the brand cap at once, and serves the other brand within its limits', async () => {
      const keyA = randomUUID()
      const keyB = randomUUID()
      const log = join(tmpdir(), `fair-${randomUUID()}.log`)
      // Elapsed milliseconds at the end of each phase, measured from the start of the test.
      const t0 = Date.now()
      const phases: Record<string, number> = {}
      const mark = (phase: string): void => {
        phases[phase] = Date.now() - t0
      }
      await sendMany('production', keyA, A_BACKLOG)
      mark('sentA')

      // stdout is ignored so test output stays clean; stderr is shown so a crash explains itself.
      const workers = Array.from({ length: processes }, () =>
        fork(
          new URL('./fairness-worker.ts', import.meta.url).pathname,
          [db.urlFor('queue'), db.urlFor('migration'), log, String(processes)],
          { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
        ),
      )
      // A worker that dies while the test is running fails it at once, with its reason.
      let crash: Error | undefined
      let stopping = false
      for (const w of workers) {
        w.on('exit', (code, signal) => {
          if (!stopping) crash ??= new Error(`worker exited early (code ${code}, signal ${signal})`)
        })
        w.on('error', (error) => {
          crash ??= error
        })
      }
      const failIfCrashed = (): void => {
        if (crash) throw crash
      }
      try {
        await Promise.all(workers.map((w) => whenReady(w, 30_000)))
        mark('workersReady')
        // Brand A must be running at its cap before B arrives, so B is competing with a live backlog.
        const startedBy = Date.now() + 30_000
        let lines: string[] = []
        for (;;) {
          failIfCrashed()
          lines = await readLines(log)
          if (lines.filter((l) => l.includes(` start production ${keyA} `)).length >= PRODUCTION_CAP) break
          if (Date.now() > startedBy) throw new Error('brand A never reached its cap of running jobs')
          await sleep(100)
        }

        mark('aAtCap')

        const sentAt = Date.now()
        const bProduction = await sendMany('production', keyB, PRODUCTION_CAP * 2)
        const bInteractive = await sendMany('interactive', keyB, INTERACTIVE_CAP + 1)
        const b = [...bProduction, ...bInteractive]
        mark('sentB')
        // Brand B's jobs must all finish while brand A still has most of its backlog waiting.
        const end = Date.now() + 60_000
        while (Date.now() < end) {
          failIfCrashed()
          lines = await readLines(log)
          if (b.every((id) => lines.some((l) => l.includes('end ') && l.includes(id)))) break
          await sleep(250)
        }
        failIfCrashed()
        const bServed = b.every((id) => lines.some((l) => l.includes('end ') && l.includes(id)))
        mark(bServed ? 'bEnded' : 'bTimedOut')
        if (!bServed) await reportStall({ keyA, keyB, b, lines, workers, phases })
        expect(bServed).toBe(true)

        // Brand B was served within 10 seconds although brand A had a 500-job backlog.
        const firstB = Math.min(
          ...lines.filter((l) => l.includes(keyB) && l.includes(' start ')).map(lineTime),
        )
        expect(firstB - sentAt).toBeLessThan(10_000)

        // A was still backlogged when B finished, so the comparison was made under load.
        const aEnded = lines.filter((l) => l.includes(` end production ${keyA} `)).length
        expect(aEnded).toBeLessThan(A_BACKLOG / 2)
        expect(await queue.depth('production')).toBeGreaterThan(0)

        // Brand A used its share and never exceeded its cap, summed over all processes. With two
        // processes the cap is split, so each process runs fewer than the whole cap.
        const peaks = {
          aProduction: peak(lines, keyA, 'production'),
          bProduction: peak(lines, keyB, 'production'),
          bInteractive: peak(lines, keyB, 'interactive'),
        }
        const firstBProduction = Math.min(
          ...lines.filter((l) => l.includes(` start production ${keyB} `)).map(lineTime),
        )
        const lastBProductionEnd = Math.max(
          ...lines.filter((l) => l.includes(` end production ${keyB} `)).map(lineTime),
        )
        console.info(
          `fairness ${processes} process(es): peaks ${JSON.stringify(peaks)}, first B start after ${firstB - sentAt} ms, first B production start after ${firstBProduction - sentAt} ms, last B production end after ${lastBProductionEnd - sentAt} ms, A ended ${aEnded}, phases ${JSON.stringify(phases)}`,
        )
        // Brand B's production jobs wait behind A's backlog in the same class (its interactive jobs have a
        // class of their own). The spec's outer limit is 10 seconds; a fair queue serves B's first one within
        // one 2 s poll plus one of A's 400 ms jobs, so 3 s. All six, at B's cap of 3, end within 6 s.
        // Without the slot wake in queue.ts, B's first production job waited 8 to 28 s on the dev server and
        // over 60 s on CI.
        expect(firstBProduction - sentAt).toBeLessThan(3_000)
        expect(lastBProductionEnd - sentAt).toBeLessThan(6_000)
        if (processes === 1) expect(peaks.aProduction).toBe(PRODUCTION_CAP)
        else expect(peaks.aProduction).toBeGreaterThanOrEqual(2)
        expect(peaks.aProduction).toBeLessThanOrEqual(PRODUCTION_CAP)
        expect(peaks.bProduction).toBeGreaterThanOrEqual(1)
        expect(peaks.bProduction).toBeLessThanOrEqual(PRODUCTION_CAP)
        expect(peaks.bInteractive).toBeGreaterThanOrEqual(1)
        expect(peaks.bInteractive).toBeLessThanOrEqual(INTERACTIVE_CAP)
      } finally {
        stopping = true
        for (const w of workers) {
          if (w.exitCode === null && w.signalCode === null) {
            const exited = once(w, 'exit')
            w.kill('SIGKILL')
            await exited
          }
        }
        await rm(log, { force: true })
      }
    }, 120_000)
  })
}
