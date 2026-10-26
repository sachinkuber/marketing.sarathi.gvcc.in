import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandContextOf } from '../src/access/brand-access.ts'
import { addBrand, addUser, createStack, enrolledClient, signedInClient, type Stack } from './support.ts'

const PASSWORD = 'correct horse battery'

describe('brands', () => {
  let stack: Stack
  let brandA: string
  let brandB: string

  beforeAll(async () => {
    stack = await createStack()
    brandA = await addBrand(stack, 'brand-a')
    brandB = await addBrand(stack, 'brand-b')
    await addUser(stack, {
      email: 'viewer@example.test',
      password: PASSWORD,
      role: 'viewer',
      brandId: brandA,
    })
    await addUser(stack, { email: 'both@example.test', password: PASSWORD, role: 'viewer', brandId: brandA })
    await stack.db.admin.query(
      "insert into app.membership (brand_id, user_id, role) select $1, id, 'viewer' from auth.\"user\" where email = 'both@example.test'",
      [brandB],
    )
    await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
  })
  afterAll(async () => stack?.close())

  it('lists only the brands the person belongs to, with their role in each', async () => {
    const viewer = await signedInClient(stack, 'viewer@example.test', PASSWORD)
    const own = await viewer.request('GET', '/api/v1/brands')
    expect(own.status).toBe(200)
    expect(own.json.brands).toEqual([
      { id: brandA, name: 'brand-a', slug: 'brand-a', status: 'onboarding', role: 'viewer' },
    ])
    const both = await signedInClient(stack, 'both@example.test', PASSWORD)
    const ids = (await both.request('GET', '/api/v1/brands')).json.brands
      .map((b: { id: string }) => b.id)
      .sort()
    expect(ids).toEqual([brandA, brandB].sort())
  })

  it('reads one brand for a member, with their role, and refuses a stranger with a 404', async () => {
    const viewer = await signedInClient(stack, 'viewer@example.test', PASSWORD)
    const read = await viewer.request('GET', `/api/v1/brands/${brandA}`)
    expect(read.status).toBe(200)
    expect(read.json).toEqual({
      id: brandA,
      name: 'brand-a',
      slug: 'brand-a',
      status: 'onboarding',
      shadowMode: false,
      role: 'viewer',
    })
    expect((await viewer.request('GET', `/api/v1/brands/${brandB}`)).status).toBe(404)
  })

  it('lets the platform owner read any brand, and lists every brand for one with no membership, each as platform_owner', async () => {
    const { client } = await enrolledClient(stack, 'owner@example.test', PASSWORD)
    const read = await client.request('GET', `/api/v1/brands/${brandB}`)
    expect(read.status).toBe(200)
    expect(read.json.role).toBe('platform_owner')
    const listed = await client.request('GET', '/api/v1/brands')
    expect(listed.status).toBe(200)
    expect(listed.json.brands).toEqual([
      { id: brandA, name: 'brand-a', slug: 'brand-a', status: 'onboarding', role: 'platform_owner' },
      { id: brandB, name: 'brand-b', slug: 'brand-b', status: 'onboarding', role: 'platform_owner' },
    ])
  })

  it('still lists only their own brand for an admin of one brand, and none for a stranger', async () => {
    await addUser(stack, {
      email: 'admin-a@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brandA,
    })
    await addUser(stack, { email: 'stranger@example.test', password: PASSWORD })
    const { client: admin } = await enrolledClient(stack, 'admin-a@example.test', PASSWORD)
    expect((await admin.request('GET', '/api/v1/brands')).json.brands).toEqual([
      { id: brandA, name: 'brand-a', slug: 'brand-a', status: 'onboarding', role: 'brand_admin' },
    ])
    const { client: stranger } = await enrolledClient(stack, 'stranger@example.test', PASSWORD)
    expect((await stranger.request('GET', '/api/v1/brands')).json.brands).toEqual([])
  })

  it('does not let the owner-only function answer for anyone else', async () => {
    const owner = await stack.db.admin.query(`select id from auth."user" where email = 'owner@example.test'`)
    const stranger = await stack.db.admin.query(
      `select id from auth."user" where email = 'viewer@example.test'`,
    )
    const asOwner = await stack.appPool.query('select * from app.brands_for_platform_owner($1)', [
      owner.rows[0].id,
    ])
    expect(asOwner.rowCount).toBe(2)
    const asViewer = await stack.appPool.query('select * from app.brands_for_platform_owner($1)', [
      stranger.rows[0].id,
    ])
    expect(asViewer.rowCount).toBe(0)
  })

  it('needs a session', async () => {
    expect((await stack.newClient().request('GET', '/api/v1/brands')).status).toBe(401)
    expect((await stack.newClient().request('GET', `/api/v1/brands/${brandA}`)).status).toBe(401)
  })
})

// A UUID is the same brand whatever its case. The brand check reads it once, in lowercase, and everything
// after it (the membership lookup, the brand context a handler reads) uses that one spelling.
describe('a brand ID in the path in uppercase', () => {
  let stack: Stack
  let brandA: string
  let brandB: string

  beforeAll(async () => {
    stack = await createStack({
      extraRoutes: (table) => {
        table.add({
          method: 'get',
          path: '/brands/:brandId/_probe/context',
          access: { kind: 'member' },
          summary: 'probe: the brand context a handler sees',
          handlers: [(_req, res) => void res.json({ brandId: brandContextOf(res).brandId })],
        })
      },
    })
    brandA = await addBrand(stack, 'brand-a')
    brandB = await addBrand(stack, 'brand-b')
    await addUser(stack, {
      email: 'viewer@example.test',
      password: PASSWORD,
      role: 'viewer',
      brandId: brandA,
    })
    await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
  })
  afterAll(async () => stack?.close())

  it('answers a member as the lowercase one does, and hands the handler the lowercase ID', async () => {
    const viewer = await signedInClient(stack, 'viewer@example.test', PASSWORD)
    const lower = await viewer.request('GET', `/api/v1/brands/${brandA}`)
    const upper = await viewer.request('GET', `/api/v1/brands/${brandA.toUpperCase()}`)
    expect(upper.status).toBe(200)
    expect(upper.json).toEqual(lower.json)
    const probe = await viewer.request('GET', `/api/v1/brands/${brandA.toUpperCase()}/_probe/context`)
    expect(probe.status).toBe(200)
    expect(probe.json.brandId).toBe(brandA)
    expect((await viewer.request('GET', `/api/v1/brands/${brandB.toUpperCase()}`)).status).toBe(404)
  })

  it('answers the platform owner for a brand that exists, in lowercase', async () => {
    const { client } = await enrolledClient(stack, 'owner@example.test', PASSWORD)
    const probe = await client.request('GET', `/api/v1/brands/${brandB.toUpperCase()}/_probe/context`)
    expect(probe.status).toBe(200)
    expect(probe.json.brandId).toBe(brandB)
  })
})
