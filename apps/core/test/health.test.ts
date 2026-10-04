import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { createLogger } from '../src/logger.ts'
import { startTestServer, type TestServer } from './support.ts'

const logger = createLogger('silent')
let server: TestServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

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
})
