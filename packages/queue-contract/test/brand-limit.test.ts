import { requireDatabase, sleep } from '@mkt/test-support'
import type { PgBoss } from 'pg-boss'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startQueue, uniqueName } from './support.ts'

type Outcome = { peak: Record<string, number>; firstStart: Record<string, number>; done: number }

// Every queue instance a test starts, so afterEach can stop them all.
const started: PgBoss[] = []

// Runs `processes` queue instances against one queue and records how many jobs
// of each brand ran at once, and when each brand's first job started.
async function run(
  processes: number,
  perProcessLimit: number,
  jobs: Record<string, number>,
): Promise<Outcome> {
  const name = uniqueName('brand')
  const instances: PgBoss[] = []
  for (let i = 0; i < processes; i += 1) instances.push(await startQueue())
  started.push(...instances)
  await instances[0]!.createQueue(name)

  for (const [brand, count] of Object.entries(jobs)) {
    for (let i = 0; i < count; i += 1)
      await instances[0]!.send(name, { brand }, { group: { id: `key-${brand}` } })
  }

  const running: Record<string, number> = {}
  const outcome: Outcome = { peak: {}, firstStart: {}, done: 0 }
  const total = Object.values(jobs).reduce((a, b) => a + b, 0)
  const began = Date.now()

  for (const instance of instances) {
    await instance.work<{ brand: string }>(
      name,
      { localGroupConcurrency: perProcessLimit, localConcurrency: 6, pollingIntervalSeconds: 0.5 },
      async (batch) => {
        await Promise.all(
          batch.map(async (job) => {
            const brand = job.data.brand
            outcome.firstStart[brand] ??= Date.now() - began
            const now = (running[brand] ?? 0) + 1
            running[brand] = now
            outcome.peak[brand] = Math.max(outcome.peak[brand] ?? 0, now)
            await sleep(400)
            running[brand] = (running[brand] ?? 1) - 1
            outcome.done += 1
          }),
        )
      },
    )
  }

  while (outcome.done < total && Date.now() - began < 45_000) await sleep(100)
  return outcome
}

describe('a brand never exceeds its cap, and never blocks another brand', () => {
  beforeAll(async () => requireDatabase())

  afterEach(async () => {
    await Promise.all(started.splice(0).map((queue) => queue.stop({ graceful: false })))
  })

  it('holds a cap of 2 exactly with one worker process', async () => {
    const outcome = await run(1, 2, { a: 30, b: 4 })
    expect(outcome.done).toBe(34)
    expect(outcome.peak.a).toBe(2)
    expect(outcome.peak.b).toBeLessThanOrEqual(2)
  })

  it('holds a cap of 2 with two worker processes given 1 each', async () => {
    const outcome = await run(2, 1, { a: 30, b: 4 })
    expect(outcome.done).toBe(34)
    expect(outcome.peak.a).toBeLessThanOrEqual(2)
    expect(outcome.peak.b).toBeLessThanOrEqual(2)
  })

  it('starts the second brand within 2 seconds while the first has 30 jobs waiting', async () => {
    const outcome = await run(1, 2, { a: 30, b: 4 })
    expect(outcome.firstStart.b).toBeLessThan(2000)
  })
})
