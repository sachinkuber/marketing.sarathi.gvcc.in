import { requireDatabase, sleep } from '@mkt/test-support'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startQueue, uniqueName } from './support.ts'

describe('a job whose worker goes silent is taken back', () => {
  let queue: PgBoss
  const name = uniqueName('heartbeat')

  beforeAll(async () => {
    await requireDatabase()
    queue = await startQueue()
    // 10 seconds is the smallest gap the library allows.
    await queue.createQueue(name, {
      heartbeatSeconds: 10,
      retryLimit: 2,
      retryDelay: 1,
      expireInSeconds: 300,
    })
  })

  afterAll(async () => queue.stop({ graceful: false }))

  it('leaves the active state after the allowed gap, long before its expiry', async () => {
    const id = await queue.send(name, {})
    expect(id).toBeTruthy()

    // fetch() claims the job and sends no heartbeats, which is what a dead worker looks like.
    const claimed = await queue.fetch(name)
    expect(claimed).toHaveLength(1)

    const started = Date.now()
    let state: string | undefined = 'active'
    while (state === 'active' && Date.now() - started < 30_000) {
      await sleep(500)
      state = (await queue.getJobById(name, id as string))?.state
    }
    const elapsed = Date.now() - started

    expect(state).toBe('retry')
    expect(elapsed).toBeGreaterThan(9_000)
    expect(elapsed).toBeLessThan(25_000)
  })

  it('keeps a job active while work() holds it longer than the gap, because the library sends the heartbeats', async () => {
    const held = uniqueName('held')
    await queue.createQueue(held, {
      heartbeatSeconds: 10,
      retryLimit: 2,
      retryDelay: 1,
      expireInSeconds: 300,
    })
    let runs = 0
    await queue.work(held, { pollingIntervalSeconds: 0.5 }, async () => {
      runs += 1
      await sleep(15_000)
    })
    const id = (await queue.send(held, {})) as string

    let job = await queue.getJobById(held, id)
    for (let i = 0; i < 80 && job?.state !== 'completed'; i += 1) {
      await sleep(500)
      job = await queue.getJobById(held, id)
    }

    expect(job?.state).toBe('completed')
    expect(runs).toBe(1)
  }, 60_000)
})
