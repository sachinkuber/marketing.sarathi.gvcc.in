import { Router } from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { csrfTokenFor, requestGuard } from '../src/guard.ts'
import { createLogger } from '../src/logger.ts'
import { startTestServer, type TestServer } from './support.ts'

const ORIGIN = 'https://app.example.test'
const SECRET = 's'.repeat(40)
let server: TestServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

async function start(sessionId: string | null) {
  const api = Router()
  api.get('/read', (_req, res) => {
    res.json({ ok: true })
  })
  api.post('/write', (_req, res) => {
    res.json({ ok: true })
  })
  server = await startTestServer(
    createApp({
      logger: createLogger('silent'),
      ready: async () => undefined,
      guard: requestGuard({ allowedOrigins: [ORIGIN], secret: SECRET, sessionIdFor: async () => sessionId }),
      api,
    }),
  )
  return server.url
}

const write = (url: string, headers: Record<string, string>) =>
  fetch(`${url}/api/v1/write`, { method: 'POST', headers, body: '{}' })

describe('request guard', () => {
  it('lets a read through with no origin and no token', async () => {
    const url = await start('session-1')
    expect((await fetch(`${url}/api/v1/read`)).status).toBe(200)
  })

  it('refuses a write that carries no Origin header', async () => {
    const url = await start(null)
    const res = await write(url, { 'content-type': 'application/json' })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('bad_origin')
  })

  it('refuses a write from another origin, and one the browser marks cross-site', async () => {
    const url = await start(null)
    const other = await write(url, {
      'content-type': 'application/json',
      origin: 'https://evil.example.test',
    })
    expect(other.status).toBe(403)
    expect((await other.json()).error.code).toBe('bad_origin')
    const cross = await write(url, {
      'content-type': 'application/json',
      origin: ORIGIN,
      'sec-fetch-site': 'cross-site',
    })
    expect(cross.status).toBe(403)
    expect((await cross.json()).error.code).toBe('cross_site_request')
  })

  it('lets a write from the right origin through when there is no session', async () => {
    const url = await start(null)
    expect((await write(url, { 'content-type': 'application/json', origin: ORIGIN })).status).toBe(200)
  })

  it('needs the per-session token once there is a session', async () => {
    const url = await start('session-1')
    const base = { 'content-type': 'application/json', origin: ORIGIN }
    const none = await write(url, base)
    expect(none.status).toBe(403)
    expect((await none.json()).error.code).toBe('bad_csrf_token')
    expect((await write(url, { ...base, 'x-csrf-token': 'wrong' })).status).toBe(403)
    expect((await write(url, { ...base, 'x-csrf-token': csrfTokenFor(SECRET, 'session-2') })).status).toBe(
      403,
    )
    expect((await write(url, { ...base, 'x-csrf-token': csrfTokenFor(SECRET, 'session-1') })).status).toBe(
      200,
    )
  })

  it('derives a different token for each session and each secret', () => {
    expect(csrfTokenFor(SECRET, 'a')).toBe(csrfTokenFor(SECRET, 'a'))
    expect(csrfTokenFor(SECRET, 'a')).not.toBe(csrfTokenFor(SECRET, 'b'))
    expect(csrfTokenFor(SECRET, 'a')).not.toBe(csrfTokenFor('t'.repeat(40), 'a'))
  })
})
