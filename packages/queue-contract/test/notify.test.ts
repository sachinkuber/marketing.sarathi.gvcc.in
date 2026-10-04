import { requireDatabase, sleep } from '@mkt/test-support'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startQueue, uniqueName } from './support.ts'

describe('notification dispatch wakes a worker without waiting for a poll', () => {
  let queue: PgBoss
  const name = uniqueName('notify')

  beforeAll(async () => {
    await requireDatabase()
    queue = await startQueue({ useListenNotify: true })
    await queue.createQueue(name, { notify: true })
  })

  afterAll(async () => queue.stop({ graceful: false }))

  it('claims each job well inside the 2-second polling interval', async () => {
    const delays: number[] = []
    let sentAt = 0
    await queue.work(name, { pollingIntervalSeconds: 2, notifyPollingIntervalSeconds: 30 }, async () => {
      delays.push(Date.now() - sentAt)
    })
    await sleep(1500) // let the listener connect

    for (let i = 0; i < 5; i += 1) {
      sentAt = Date.now()
      await queue.send(name, {})
      await sleep(600)
    }

    expect(delays).toHaveLength(5)
    // The spec needs 95 percent of interactive jobs claimed within 1 second.
    for (const delay of delays) expect(delay).toBeLessThan(1000)
  })
})
