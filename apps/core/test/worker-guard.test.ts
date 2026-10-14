import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createStack, type Stack } from './support.ts'

let stack: Stack
const JOB = '12345678-1234-4234-8234-123456789012'

beforeAll(async () => {
  stack = await createStack({ withQueue: true })
})
afterAll(async () => {
  await stack?.close()
})

const post = (path: string, headers: Record<string, string>) =>
  fetch(`${stack.server.url}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ workerId: 'w' }),
  })

describe('the request guard and worker calls', () => {
  it('lets a request with an Authorization header through the origin check to the credential check', async () => {
    const res = await post(`/worker/jobs/${JOB}/attempts`, {
      authorization: 'Worker wrong',
      origin: 'https://evil.example',
    })
    expect(res.status).toBe(401)
  })

  it('still refuses a worker route with no Authorization header at the origin check', async () => {
    const res = await post(`/worker/jobs/${JOB}/attempts`, {})
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('bad_origin')
  })

  it('does not extend the exemption to any route outside /worker', async () => {
    const res = await post('/brands', { authorization: `Worker ${stack.jobs?.workerSecret}` })
    expect(res.status).toBe(403)
  })
})
