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

for (const processes of [1, 2]) {
  describe(`acceptance test 29 with ${processes} worker process${processes > 1 ? 'es' : ''}`, () => {
    it('never runs more than the brand cap at once, and serves the other brand within its limits', async () => {
      const keyA = randomUUID()
      const keyB = randomUUID()
      const log = join(tmpdir(), `fair-${randomUUID()}.log`)
      await sendMany('production', keyA, 500)

      const workers = Array.from({ length: processes }, () =>
        fork(new URL('./fairness-worker.ts', import.meta.url).pathname, [
          db.urlFor('queue'),
          db.urlFor('migration'),
          log,
          String(processes),
        ]),
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
        const firstB = Math.min(
          ...lines
            .filter((l) => l.includes(keyB) && l.includes(' start '))
            .map((l) => Number(l.split(' ')[0])),
        )
        expect(firstB - sentAt).toBeLessThan(10_000)
        // Brand A never ran more than its cap (3 for production), summed over all processes.
        const peaks = {
          aProduction: peak(lines, keyA, 'production'),
          bProduction: peak(lines, keyB, 'production'),
          bInteractive: peak(lines, keyB, 'interactive'),
        }
        console.info(
          `fairness ${processes} process(es): peaks ${JSON.stringify(peaks)}, first B start after ${firstB - sentAt} ms`,
        )
        expect(peaks.aProduction).toBeLessThanOrEqual(3)
        expect(peaks.bProduction).toBeLessThanOrEqual(3)
        expect(peaks.bInteractive).toBeLessThanOrEqual(2)
      } finally {
        for (const w of workers) w.kill('SIGKILL')
        await rm(log, { force: true })
      }
    }, 120_000)
  })
}
