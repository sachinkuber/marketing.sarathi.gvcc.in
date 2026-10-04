import { Router } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createApp } from '../src/app.ts'
import { AppError } from '../src/errors.ts'
import { createLogger } from '../src/logger.ts'
import { validate } from '../src/validate.ts'
import { startTestServer, type TestServer } from './support.ts'

const ID = '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b'

function buildApi() {
  const api = Router()
  api.get('/boom', () => {
    throw new Error('database password is hunter2')
  })
  api.get('/conflict', () => {
    throw new AppError(409, 'conflict', 'Already there.')
  })
  api.post('/echo', validate({ body: z.strictObject({ name: z.string().min(1) }) }), (_req, res) => {
    res.json(res.locals.input.body)
  })
  api.get(
    '/items/:id',
    validate({
      params: z.strictObject({ id: z.uuid() }),
      query: z.strictObject({ page: z.coerce.number().int().min(1).default(1) }),
    }),
    (_req, res) => {
      res.json(res.locals.input)
    },
  )
  return api
}

let server: TestServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

async function start(lines: string[] = []) {
  const logger = createLogger('info', { write: (line: string) => void lines.push(line) })
  server = await startTestServer(createApp({ logger, ready: async () => undefined, api: buildApi() }))
  return server.url
}

describe('the service shell', () => {
  it('answers an unexpected error with a fixed message and no detail', async () => {
    const url = await start()
    const res = await fetch(`${url}/api/v1/boom`)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: { code: 'internal_error', message: 'Something went wrong.' } })
    expect(text).not.toContain('hunter2')
  })

  it('answers an application error with its own status and code', async () => {
    const url = await start()
    const res = await fetch(`${url}/api/v1/conflict`)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: { code: 'conflict', message: 'Already there.' } })
  })

  it('answers an unknown address with 404 in the same shape', async () => {
    const url = await start()
    const res = await fetch(`${url}/api/v1/nothing-here`)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('not_found')
  })

  it('refuses a body that is not JSON, and a body that is too large', async () => {
    const url = await start()
    const bad = await fetch(`${url}/api/v1/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe('invalid_json')
    const big = await fetch(`${url}/api/v1/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(200_000) }),
    })
    expect(big.status).toBe(413)
    expect((await big.json()).error.code).toBe('payload_too_large')
  })

  it('accepts a valid body and refuses an unknown field', async () => {
    const url = await start()
    const post = (body: unknown) =>
      fetch(`${url}/api/v1/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const ok = await post({ name: 'Aztek' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ name: 'Aztek' })
    const extra = await post({ name: 'Aztek', colour: 'red' })
    expect(extra.status).toBe(400)
    const json = await extra.json()
    expect(json.error.code).toBe('invalid_request')
    expect(JSON.stringify(json.error.details)).toContain('colour')
  })

  it('validates path and query parts and applies defaults', async () => {
    const url = await start()
    const ok = await fetch(`${url}/api/v1/items/${ID}`)
    expect((await ok.json()).query.page).toBe(1)
    expect((await fetch(`${url}/api/v1/items/not-a-uuid`)).status).toBe(400)
    expect((await fetch(`${url}/api/v1/items/${ID}?page=0`)).status).toBe(400)
    expect((await fetch(`${url}/api/v1/items/${ID}?extra=1`)).status).toBe(400)
  })

  it('sets security headers, hides the framework and returns a request ID', async () => {
    const url = await start()
    const res = await fetch(`${url}/health/live`)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-powered-by')).toBeNull()
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('logs the path without its query string, and hides tokens in paths', async () => {
    const lines: string[] = []
    const url = await start(lines)
    await fetch(`${url}/api/v1/items/${ID}?page=2&token=abc123`)
    await fetch(`${url}/api/auth/reset-password/secret-reset-token`)
    await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(2))
    const out = lines.join('')
    expect(out).toContain(`/api/v1/items/${ID}`)
    expect(out).not.toContain('page=2')
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('secret-reset-token')
  })
})
