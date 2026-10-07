import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBrand, addUser, createStack, enrolledClient, signedInClient, type Stack } from './support.ts'
import type { TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
const RANDOM = '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b'

describe('what each kind of access lets through', () => {
  let stack: Stack
  let brandA: string
  let brandB: string
  let unenrolled: TestClient
  let approver: TestClient
  let viewer: TestClient
  let owner: TestClient

  beforeAll(async () => {
    stack = await createStack({
      extraRoutes: (table) => {
        const probe = (path: string, access: Parameters<typeof table.add>[0]['access']) =>
          table.add({
            method: 'get',
            path,
            access,
            summary: 'probe',
            handlers: [
              (_req, res) => {
                res.json({ ok: true })
              },
            ],
          })
        probe('/_probe/public', { kind: 'public' })
        probe('/_probe/signed_in', { kind: 'signed_in' })
        probe('/_probe/enrolled', { kind: 'enrolled' })
        probe('/_probe/platform_owner', { kind: 'platform_owner' })
        probe('/brands/:brandId/_probe/member', { kind: 'member' })
      },
    })
    brandA = await addBrand(stack, 'brand-a')
    brandB = await addBrand(stack, 'brand-b')
    await addUser(stack, {
      email: 'unenrolled@example.test',
      password: PASSWORD,
      role: 'approver',
      brandId: brandA,
    })
    await addUser(stack, {
      email: 'approver@example.test',
      password: PASSWORD,
      role: 'approver',
      brandId: brandA,
    })
    await addUser(stack, {
      email: 'viewer@example.test',
      password: PASSWORD,
      role: 'viewer',
      brandId: brandA,
    })
    await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
    unenrolled = await signedInClient(stack, 'unenrolled@example.test', PASSWORD)
    approver = (await enrolledClient(stack, 'approver@example.test', PASSWORD)).client
    viewer = await signedInClient(stack, 'viewer@example.test', PASSWORD)
    owner = (await enrolledClient(stack, 'owner@example.test', PASSWORD)).client
  })
  afterAll(async () => stack?.close())

  const get = (client: TestClient, path: string) => client.request('GET', path)

  it('public: anyone, with no session', async () => {
    expect((await get(stack.newClient(), '/api/v1/_probe/public')).status).toBe(200)
  })

  it('signed_in: needs a session but not a finished enrolment', async () => {
    expect((await get(stack.newClient(), '/api/v1/_probe/signed_in')).status).toBe(401)
    expect((await get(unenrolled, '/api/v1/_probe/signed_in')).status).toBe(200)
  })

  it('enrolled: needs a session and, where required, a second factor', async () => {
    expect((await get(stack.newClient(), '/api/v1/_probe/enrolled')).status).toBe(401)
    const blocked = await get(unenrolled, '/api/v1/_probe/enrolled')
    expect(blocked.status).toBe(403)
    expect(blocked.json.error.code).toBe('enrolment_required')
    expect((await get(viewer, '/api/v1/_probe/enrolled')).status).toBe(200)
    expect((await get(approver, '/api/v1/_probe/enrolled')).status).toBe(200)
  })

  it('platform_owner: only the platform owner', async () => {
    expect((await get(stack.newClient(), '/api/v1/_probe/platform_owner')).status).toBe(401)
    expect((await get(viewer, '/api/v1/_probe/platform_owner')).status).toBe(403)
    expect((await get(approver, '/api/v1/_probe/platform_owner')).status).toBe(403)
    expect((await get(owner, '/api/v1/_probe/platform_owner')).status).toBe(200)
  })

  it('member: a member of that brand, or the platform owner for any brand that exists; otherwise 404', async () => {
    const path = (brand: string) => `/api/v1/brands/${brand}/_probe/member`
    expect((await get(stack.newClient(), path(brandA))).status).toBe(401)
    expect((await get(unenrolled, path(brandA))).status).toBe(403)
    expect((await get(approver, path(brandA))).status).toBe(200)
    expect((await get(viewer, path(brandA))).status).toBe(200)
    // Not a member of brand B: 404, the same answer as for a brand that does not exist or an ID that is not one.
    const other = await get(approver, path(brandB))
    expect(other.status).toBe(404)
    expect((await get(approver, path(RANDOM))).status).toBe(404)
    expect((await get(approver, path('not-a-uuid'))).status).toBe(404)
    expect((await get(approver, path(RANDOM))).json).toEqual(other.json)
    // The platform owner has no membership anywhere and can open any brand that exists.
    expect((await get(owner, path(brandB))).status).toBe(200)
    expect((await get(owner, path(RANDOM))).status).toBe(404)
  })
})
