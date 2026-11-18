import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { createLogger } from '../src/logger.ts'
import { createStack, startTestServer, type Stack, type TestServer } from './support.ts'

const logger = createLogger('silent')
let server: TestServer | undefined
let stack: Stack | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  await stack?.close()
  stack = undefined
})

const NOW = new Date('2026-11-17T12:00:00.000Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)
const workerApp = (workerLastSeen: () => Promise<Date | null>) =>
  createApp({ logger, ready: async () => undefined, now: () => NOW, workerLastSeen })

describe('health endpoints', () => {
  it('answers liveness without touching the database', async () => {
    let calls = 0
    server = await startTestServer(
      createApp({
        logger,
        ready: async () => {
          calls++
        },
      }),
    )
    const res = await fetch(`${server.url}/health/live`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(calls).toBe(0)
  })

  it('answers readiness 200 when the check passes', async () => {
    server = await startTestServer(createApp({ logger, ready: async () => undefined }))
    const res = await fetch(`${server.url}/health/ready`)
    expect(res.status).toBe(200)
  })

  it('answers readiness 503 with no detail when the check fails', async () => {
    server = await startTestServer(
      createApp({
        logger,
        ready: async () => {
          throw new Error('connect ECONNREFUSED 10.0.0.5:5432')
        },
      }),
    )
    const res = await fetch(`${server.url}/health/ready`)
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ status: 'unavailable' })
    expect(text).not.toContain('ECONNREFUSED')
  })

  it('answers the heartbeat with the current time', async () => {
    server = await startTestServer(
      createApp({
        logger,
        ready: async () => undefined,
        now: () => new Date('2026-10-04T12:00:00.000Z'),
      }),
    )
    const res = await fetch(`${server.url}/health/heartbeat`)
    expect(await res.json()).toEqual({ status: 'ok', at: '2026-10-04T12:00:00.000Z' })
  })

  it('is also mounted at /api/health, with the same answers as /health', async () => {
    server = await startTestServer(
      createApp({
        logger,
        ready: async () => {
          throw new Error('down')
        },
        now: () => NOW,
        workerLastSeen: async () => minutesAgo(1),
      }),
    )
    for (const path of ['live', 'ready', 'heartbeat', 'worker']) {
      const old = await fetch(`${server.url}/health/${path}`)
      const proxied = await fetch(`${server.url}/api/health/${path}`)
      expect(proxied.status, path).toBe(old.status)
      expect(await proxied.json(), path).toEqual(await old.json())
    }
    expect((await fetch(`${server.url}/api/health/ready`)).status).toBe(503)
    expect((await fetch(`${server.url}/api/health/worker`)).status).toBe(200)
  })

  it('answers /health/worker 200 with the last-seen time when a stamp is under 15 minutes old', async () => {
    server = await startTestServer(workerApp(async () => minutesAgo(14)))
    const res = await fetch(`${server.url}/health/worker`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', lastSeen: minutesAgo(14).toISOString() })
  })

  it('answers /health/worker 503 stale when the stamp is older than 15 minutes', async () => {
    server = await startTestServer(workerApp(async () => minutesAgo(16)))
    const res = await fetch(`${server.url}/health/worker`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'stale', lastSeen: minutesAgo(16).toISOString() })
  })

  it('honours a configured stale-after time', async () => {
    server = await startTestServer(
      createApp({
        logger,
        ready: async () => undefined,
        now: () => NOW,
        workerLastSeen: async () => minutesAgo(2),
        workerStaleAfterMs: 60_000,
      }),
    )
    expect((await fetch(`${server.url}/health/worker`)).status).toBe(503)
  })

  it('answers /health/worker 503 never when there is no stamp, and unavailable with no detail on failure', async () => {
    server = await startTestServer(workerApp(async () => null))
    const never = await fetch(`${server.url}/health/worker`)
    expect(never.status).toBe(503)
    expect(await never.json()).toEqual({ status: 'never' })
    await server.close()
    server = await startTestServer(
      workerApp(async () => {
        throw new Error('connect ECONNREFUSED 192.0.2.5:5432')
      }),
    )
    const down = await fetch(`${server.url}/health/worker`)
    expect(down.status).toBe(503)
    const text = await down.text()
    expect(JSON.parse(text)).toEqual({ status: 'unavailable' })
    expect(text).not.toContain('ECONNREFUSED')
  })

  it('answers the worker check as never when the app is built without a heartbeat source', async () => {
    server = await startTestServer(createApp({ logger, ready: async () => undefined }))
    expect(await (await fetch(`${server.url}/health/worker`)).json()).toEqual({ status: 'never' })
  })

  it('the tick route stamps the worker, and the core answers /health/worker from it', async () => {
    stack = await createStack({ withQueue: true })
    const before = await fetch(`${stack.server.url}/api/health/worker`)
    expect(before.status).toBe(503)
    expect(await before.json()).toEqual({ status: 'never' })
    const tick = await fetch(`${stack.server.url}/api/v1/worker/approvals/tick`, {
      method: 'POST',
      headers: {
        authorization: `Worker ${stack.jobs!.workerSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ workerId: 'worker-under-test' }),
    })
    expect(tick.status).toBe(200)
    const rows = await stack.db.admin.query('select worker_id from app.worker_heartbeat')
    expect(rows.rows).toEqual([{ worker_id: 'worker-under-test' }])
    const after = await fetch(`${stack.server.url}/health/worker`)
    expect(after.status).toBe(200)
    expect((await after.json()).status).toBe('ok')
  })

  it('refuses a tick with no worker id, and stamps nothing', async () => {
    stack = await createStack({ withQueue: true })
    const tick = await fetch(`${stack.server.url}/api/v1/worker/approvals/tick`, {
      method: 'POST',
      headers: {
        authorization: `Worker ${stack.jobs!.workerSecret}`,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    expect(tick.status).toBe(400)
    expect((await stack.db.admin.query('select 1 from app.worker_heartbeat')).rowCount).toBe(0)
  })
})
