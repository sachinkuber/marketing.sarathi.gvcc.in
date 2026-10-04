import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
const SOME_USER = '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b'

// Acceptance test 1: with a session for brand A, every operation refuses or returns nothing for brand B's
// records. It reads the route table, so a route added later is covered without anyone remembering to add it.
describe('no route under /brands/:brandId answers for a brand the person is not in', () => {
  let stack: Stack
  let brandA: string
  let brandB: string
  let admin: TestClient

  beforeAll(async () => {
    stack = await createStack()
    brandA = await addBrand(stack, 'brand-a')
    brandB = await addBrand(stack, 'brand-b')
    await addUser(stack, {
      email: 'admin@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brandA,
    })
    admin = (await enrolledClient(stack, 'admin@example.test', PASSWORD)).client
  })
  afterAll(async () => stack?.close())

  const fill = (path: string, brand: string) =>
    path.replace(':brandId', brand).replace(/:[a-zA-Z]+/g, SOME_USER)

  it('finds the brand-scoped routes, so the checks below cannot pass on an empty list', () => {
    const scoped = stack.core.routes.list().filter((r) => r.path.includes(':brandId'))
    expect(scoped.length).toBeGreaterThanOrEqual(5)
  })

  it('answers 404 to a member of brand A for every route when the path names brand B', async () => {
    for (const route of stack.core.routes.list().filter((r) => r.path.includes(':brandId'))) {
      const reply = await admin.request(route.method.toUpperCase(), `/api/v1${fill(route.path, brandB)}`, {
        body: route.method === 'get' ? undefined : {},
      })
      expect(reply.status, `${route.method} ${route.path}`).toBe(404)
      expect(reply.text).not.toContain(brandB)
      expect(reply.json.error.code).toBe('not_found')
    }
  })

  it('does not answer 404 for the same routes in the person’s own brand', async () => {
    for (const route of stack.core.routes.list().filter((r) => r.path.includes(':brandId'))) {
      const reply = await admin.request(route.method.toUpperCase(), `/api/v1${fill(route.path, brandA)}`, {
        body: route.method === 'get' ? undefined : {},
      })
      expect([401, 404], `${route.method} ${route.path}`).not.toContain(reply.status)
      expect(reply.status, `${route.method} ${route.path}`).toBeLessThan(500)
    }
  })

  it('answers 401 with no session and 403 enrolment_required to someone not yet enrolled, for every such route', async () => {
    await addUser(stack, { email: 'new@example.test', password: PASSWORD, role: 'approver', brandId: brandA })
    const fresh = stack.newClient()
    await fresh.signIn('new@example.test', PASSWORD)
    for (const route of stack.core.routes.list().filter((r) => r.path.includes(':brandId'))) {
      const path = `/api/v1${fill(route.path, brandA)}`
      const none = await stack.newClient().request(route.method.toUpperCase(), path, {
        body: route.method === 'get' ? undefined : {},
        origin: 'https://app.example.test',
      })
      // The origin header is sent, so the request guard has no reason to refuse it: only the missing session.
      expect(none.status, `${route.method} ${route.path}`).toBe(401)
      const blocked = await fresh.request(route.method.toUpperCase(), path, {
        body: route.method === 'get' ? undefined : {},
      })
      expect(blocked.status, `${route.method} ${route.path}`).toBe(403)
      expect(blocked.json.error.code).toBe('enrolment_required')
    }
  })
})
