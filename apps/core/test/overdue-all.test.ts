import { withBrand } from '@mkt/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { tick } from '../src/approvals/requests.ts'
import { createVersion, moveState } from '../src/content/versions.ts'
import { ManualClock } from '../src/notify/doubles.ts'
import {
  addBrand,
  addUser,
  createStack,
  enrolledClient,
  totp,
  type Stack,
  type TestClient,
} from './support.ts'

const PASSWORD = 'correct horse battery'
const H = 3_600_000

let stack: Stack
let clock: ManualClock
let seq = 0

const deps = () => ({ clock, audit: stack.audit })

async function waiting(brandId: string, title: string, kind: 'article' | 'strategy_brief' = 'article') {
  const item = (
    await stack.db.admin.query(`insert into app.content_item (brand_id, kind) values ($1, $2) returning id`, [
      brandId,
      kind,
    ])
  ).rows[0].id as string
  const actor = { kind: 'system' as const }
  const v = await withBrand(stack.appPool, brandId, async (client) => {
    const created = await createVersion(client, deps(), {
      brandId,
      contentItemId: item,
      payload: {
        kind,
        language: 'en',
        title,
        body: [{ type: 'paragraph' as const, text: `Text ${title}` }],
      },
      createdBy: actor,
    })
    await moveState(client, deps(), created.versionId, 'in_checks', actor)
    await moveState(client, deps(), created.versionId, 'awaiting_approval', actor)
    return created
  })
  await stack.db.admin.query(
    'update app.approval_request set requested_at = $2 where content_version_id = $1',
    [v.versionId, clock.now()],
  )
  const request = await stack.db.admin.query(
    'select id from app.approval_request where content_version_id = $1',
    [v.versionId],
  )
  return { item, requestId: request.rows[0].id as string }
}

async function makeOverdue(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    clock.advance(25 * H)
    await tick(stack.appPool, deps())
  }
}

async function person(role: 'approver' | 'viewer' | 'brand_admin', brandId: string) {
  seq += 1
  const email = `p${seq}@example.test`
  await addUser(stack, { email, password: PASSWORD, role, brandId })
  const made = await enrolledClient(stack, email, PASSWORD)
  return { ...made, email }
}

const all = (c: TestClient) => c.request('GET', '/api/v1/overdue')

beforeAll(async () => {
  clock = new ManualClock(new Date('2026-03-02T09:00:00Z'))
  stack = await createStack({ withQueue: true, clock })
})
afterEach(async () => {
  await stack.db.admin.query('update app.approval_request set closed_at = now() where closed_at is null')
})
afterAll(async () => {
  await stack?.close()
})

describe('GET /overdue: overdue items across the brands the caller may approve in', () => {
  it('lists the caller’s brand with its count, pop-up state and first request, and never another brand’s items', async () => {
    const brandA = await addBrand(stack, 'oa-a')
    const brandB = await addBrand(stack, 'oa-b')
    const a = await waiting(brandA, 'Alpha')
    await waiting(brandB, 'Bravo')
    const approverA = await person('approver', brandA)
    await makeOverdue()
    const reply = await all(approverA.client)
    expect(reply.status).toBe(200)
    expect(reply.json.brands).toHaveLength(1)
    const entry = reply.json.brands[0]
    expect(entry).toMatchObject({
      brandId: brandA,
      brandName: 'oa-a',
      count: 1,
      popupDue: true,
      firstRequestId: a.requestId,
      firstItemId: a.item,
    })
    expect(entry.items.map((i: { title: string }) => i.title)).toEqual(['Alpha'])
    expect(JSON.stringify(reply.json)).not.toContain('Bravo')
    expect(JSON.stringify(reply.json)).not.toContain(brandB)
  })

  it('answers an empty list to a viewer, and to an approver with nothing overdue', async () => {
    const brand = await addBrand(stack, 'oa-v')
    await waiting(brand, 'Hidden')
    await makeOverdue()
    const viewer = await person('viewer', brand)
    expect((await all(viewer.client)).json).toEqual({ brands: [] })
    const quietBrand = await addBrand(stack, 'oa-quiet')
    const quiet = await person('approver', quietBrand)
    expect((await all(quiet.client)).json).toEqual({ brands: [] })
  })

  it('follows the per-session answer rule: later stops the pop-up, the count stays, a new sign-in asks again', async () => {
    const brand = await addBrand(stack, 'oa-ack')
    await waiting(brand, 'Ack me')
    const p = await person('approver', brand)
    await makeOverdue()
    expect((await all(p.client)).json.brands[0].popupDue).toBe(true)
    const ack = await p.client.request('POST', `/api/v1/brands/${brand}/approvals/overdue/ack`, {
      body: { choice: 'later' },
    })
    expect(ack.status).toBe(201)
    const after = (await all(p.client)).json.brands[0]
    expect(after.count).toBe(1)
    expect(after.popupDue).toBe(false)
    const again = stack.newClient()
    await again.signIn(p.email, PASSWORD)
    await again.request('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp(p.secret) } })
    await again.refreshCsrf()
    expect((await all(again)).json.brands[0].popupDue).toBe(true)
  })

  it('gives the platform owner every brand that has something overdue', async () => {
    const brandA = await addBrand(stack, 'oo-a')
    const brandB = await addBrand(stack, 'oo-b')
    await waiting(brandA, 'One')
    await waiting(brandB, 'Two')
    await addUser(stack, { email: 'oo-owner@example.test', password: PASSWORD, platformOwner: true })
    const { client } = await enrolledClient(stack, 'oo-owner@example.test', PASSWORD)
    await makeOverdue()
    const ids = (await all(client)).json.brands.map((b: { brandId: string }) => b.brandId)
    expect(ids).toEqual(expect.arrayContaining([brandA, brandB]))
  })

  it('lists an overdue strategy brief to the platform owner only, never to its admins and approvers', async () => {
    const brand = await addBrand(stack, 'oa-brief')
    await waiting(brand, 'Article A')
    await waiting(brand, 'The brief', 'strategy_brief')
    const admin = await person('brand_admin', brand)
    const approver = await person('approver', brand)
    // The brief's reminders go to the platform owners, so one must exist for it to become overdue.
    await addUser(stack, { email: 'ob-owner@example.test', password: PASSWORD, platformOwner: true })
    const owner = await enrolledClient(stack, 'ob-owner@example.test', PASSWORD)
    await makeOverdue()
    const titles = (body: { items: { title: string }[] }) => body.items.map((i) => i.title).sort()
    for (const p of [admin, approver]) {
      const across = (await all(p.client)).json.brands
      expect(across).toHaveLength(1)
      expect(across[0]).toMatchObject({ brandId: brand, count: 1 })
      expect(titles(across[0])).toEqual(['Article A'])
      const one = await p.client.request('GET', `/api/v1/brands/${brand}/approvals/overdue`)
      expect(one.status).toBe(200)
      expect(titles(one.json)).toEqual(['Article A'])
      expect(one.json.count).toBe(1)
      // Answering the pop-up records only what it showed.
      const ack = await p.client.request('POST', `/api/v1/brands/${brand}/approvals/overdue/ack`, {
        body: { choice: 'later' },
      })
      expect(ack.json.acknowledged).toBe(1)
    }
    const mine = (await all(owner.client)).json.brands.find((b: { brandId: string }) => b.brandId === brand)
    expect(mine.count).toBe(2)
    expect(titles(mine)).toEqual(['Article A', 'The brief'])
  })

  it('needs a session', async () => {
    expect((await all(stack.newClient())).status).toBe(401)
  })
})
