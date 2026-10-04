import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ACTORS, PERMISSION_KEYS, grantFor, type Actor } from '../src/access/permissions.ts'
import {
  addBrand,
  addUser,
  createStack,
  enrolledClient,
  signedInClient,
  type Stack,
  type TestClient,
} from './support.ts'

const PASSWORD = 'correct horse battery'
const RANDOM = '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b'

// Each role is allowed and denied exactly as PRD 16.1 states, for every permission, over HTTP. One probe
// route per permission stands in for the real routes, which are checked for declaration by the other file.
describe('each role is allowed and denied as the PRD access table states (acceptance test 13)', () => {
  let stack: Stack
  let brand: string
  let otherBrand: string
  const clients = new Map<Actor, TestClient>()

  beforeAll(async () => {
    stack = await createStack({
      extraRoutes: (table) => {
        for (const permission of PERMISSION_KEYS) {
          table.add({
            method: 'get',
            path: `/brands/:brandId/_probe/${permission}`,
            access: { kind: 'permission', permission },
            summary: `probe for ${permission}`,
            handlers: [(_req, res) => void res.json({ ok: true })],
          })
        }
      },
    })
    brand = await addBrand(stack, 'brand-a')
    otherBrand = await addBrand(stack, 'brand-b')
    await addUser(stack, {
      email: 'admin@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brand,
    })
    await addUser(stack, {
      email: 'approver@example.test',
      password: PASSWORD,
      role: 'approver',
      brandId: brand,
    })
    await addUser(stack, {
      email: 'sales@example.test',
      password: PASSWORD,
      role: 'sales_contact',
      brandId: brand,
    })
    await addUser(stack, { email: 'viewer@example.test', password: PASSWORD, role: 'viewer', brandId: brand })
    await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
    clients.set('brand_admin', (await enrolledClient(stack, 'admin@example.test', PASSWORD)).client)
    clients.set('approver', (await enrolledClient(stack, 'approver@example.test', PASSWORD)).client)
    clients.set('sales_contact', (await enrolledClient(stack, 'sales@example.test', PASSWORD)).client)
    clients.set('viewer', await signedInClient(stack, 'viewer@example.test', PASSWORD))
    clients.set('platform_owner', (await enrolledClient(stack, 'owner@example.test', PASSWORD)).client)
  })
  afterAll(async () => stack?.close())

  it('has a client for every role the matrix names', () => {
    expect([...clients.keys()].sort()).toEqual([...ACTORS].sort())
  })

  for (const permission of PERMISSION_KEYS) {
    it(`${permission}: allowed for the roles the PRD grants it to, 403 for the rest`, async () => {
      for (const actor of ACTORS) {
        const reply = await clients.get(actor)!.request('GET', `/api/v1/brands/${brand}/_probe/${permission}`)
        const expected = grantFor(actor, permission) ? 200 : 403
        expect(reply.status, `${actor} / ${permission}`).toBe(expected)
      }
    })
  }

  it('answers 404, not 403, to everyone who is not in the brand, for every permission', async () => {
    for (const permission of PERMISSION_KEYS) {
      for (const actor of ACTORS.filter((a) => a !== 'platform_owner')) {
        const reply = await clients
          .get(actor)!
          .request('GET', `/api/v1/brands/${otherBrand}/_probe/${permission}`)
        expect(reply.status, `${actor} / ${permission}`).toBe(404)
      }
    }
  })

  it('lets the platform owner into any brand that exists, and gives a brand that does not exist a 404', async () => {
    const owner = clients.get('platform_owner')!
    expect((await owner.request('GET', `/api/v1/brands/${otherBrand}/_probe/manage_users`)).status).toBe(200)
    expect((await owner.request('GET', `/api/v1/brands/${RANDOM}/_probe/manage_users`)).status).toBe(404)
  })
})
