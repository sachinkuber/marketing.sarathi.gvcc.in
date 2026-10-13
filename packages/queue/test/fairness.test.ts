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
      await sendMany('production', keyA, A_BACKLOG)

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

        const sentAt = Date.now()
        const bProduction = await sendMany('production', keyB, PRODUCTION_CAP * 2)
        const bInteractive = await sendMany('interactive', keyB, INTERACTIVE_CAP + 1)
        const b = [...bProduction, ...bInteractive]
        // Brand B's jobs must all finish while brand A still has most of its backlog waiting.
        const end = Date.now() + 60_000
        while (Date.now() < end) {
          failIfCrashed()
          lines = await readLines(log)
          if (b.every((id) => lines.some((l) => l.includes('end ') && l.includes(id)))) break
          await sleep(250)
        }
        failIfCrashed()
        expect(b.every((id) => lines.some((l) => l.includes('end ') && l.includes(id)))).toBe(true)

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
        console.info(
          `fairness ${processes} process(es): peaks ${JSON.stringify(peaks)}, first B start after ${firstB - sentAt} ms, A ended ${aEnded}`,
        )
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
