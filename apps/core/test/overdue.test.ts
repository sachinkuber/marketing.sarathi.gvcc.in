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
  signedInClient,
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

interface Setup {
  brandId: string
  approver: TestClient
  secret: string
  email: string
  viewer: TestClient
  sales: TestClient
}

async function makeBrand(): Promise<Setup> {
  seq += 1
  const brandId = await addBrand(stack, `od-${seq}`)
  const email = `ap${seq}@example.test`
  await addUser(stack, { email, password: PASSWORD, role: 'approver', brandId })
  await addUser(stack, { email: `ad${seq}@example.test`, password: PASSWORD, role: 'brand_admin', brandId })
  await addUser(stack, { email: `vw${seq}@example.test`, password: PASSWORD, role: 'viewer', brandId })
  await addUser(stack, { email: `sc${seq}@example.test`, password: PASSWORD, role: 'sales_contact', brandId })
  const { client, secret } = await enrolledClient(stack, email, PASSWORD)
  return {
    brandId,
    approver: client,
    secret,
    email,
    viewer: await signedInClient(stack, `vw${seq}@example.test`, PASSWORD),
    sales: (await enrolledClient(stack, `sc${seq}@example.test`, PASSWORD)).client,
  }
}

// A new sign-in of the same person: a new session.
async function signInAgain(b: Setup): Promise<TestClient> {
  const next = stack.newClient()
  await next.signIn(b.email, PASSWORD)
  const verify = await next.request('POST', '/api/auth/two-factor/verify-totp', {
    body: { code: totp(b.secret) },
  })
  if (verify.status !== 200) throw new Error(`verify failed: ${verify.status} ${verify.text}`)
  await next.refreshCsrf()
  return next
}

async function waiting(brandId: string, title = 'Spring offer') {
  const item = (
    await stack.db.admin.query(
      `insert into app.content_item (brand_id, kind) values ($1, 'article') returning id`,
      [brandId],
    )
  ).rows[0].id as string
  const actor = { kind: 'system' as const }
  const v = await withBrand(stack.appPool, brandId, async (client) => {
    const created = await createVersion(client, deps(), {
      brandId,
      contentItemId: item,
      payload: {
        kind: 'article' as const,
        language: 'en',
        title,
        body: [{ type: 'paragraph' as const, text: `Hi ${seq}` }],
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
  const hash = (
    await stack.db.admin.query('select hash from app.content_version where id = $1', [v.versionId])
  ).rows[0].hash as string
  return { item, versionId: v.versionId, hash }
}

// Four ticks 25 hours apart: reminders at the first three, overdue on the fourth.
async function makeOverdue(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    clock.advance(25 * H)
    await tick(stack.appPool, deps())
  }
}

const overdue = (c: TestClient, brandId: string) =>
  c.request('GET', `/api/v1/brands/${brandId}/approvals/overdue`)
const ack = (c: TestClient, brandId: string, choice: string) =>
  c.request('POST', `/api/v1/brands/${brandId}/approvals/overdue/ack`, { body: { choice } })

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

describe('overdue pop-up and banner data (test 22, API half)', () => {
  it('shows nothing before an item is overdue, then lists it with the pop-up due', async () => {
    const b = await makeBrand()
    await waiting(b.brandId)
    const before = await overdue(b.approver, b.brandId)
    expect(before.status).toBe(200)
    expect(before.json).toEqual({ items: [], count: 0, popup: { due: false } })
    await makeOverdue()
    const after = await overdue(b.approver, b.brandId)
    expect(after.json.count).toBe(1)
    expect(after.json.popup).toEqual({ due: true })
    expect(after.json.items).toHaveLength(1)
    expect(Object.keys(after.json.items[0]).sort()).toEqual([
      'contentItemId',
      'overdueSince',
      'requestedAt',
      'title',
      'versionId',
    ])
    expect(after.json.items[0].title).toBe('Spring offer')
  })

  it('records "later", leaves the banner count unchanged and stops the pop-up in this session', async () => {
    const b = await makeBrand()
    await waiting(b.brandId)
    await makeOverdue()
    const done = await ack(b.approver, b.brandId, 'later')
    expect(done.status).toBe(201)
    const rows = await stack.db.admin.query('select choice from app.popup_ack where brand_id = $1', [
      b.brandId,
    ])
    expect(rows.rows.map((r) => r.choice)).toEqual(['later'])
    const after = await overdue(b.approver, b.brandId)
    expect(after.json.count).toBe(1)
    expect(after.json.popup).toEqual({ due: false })
    expect(
      stack.audit.entries.some((e) => e.action === 'approval.popup_acknowledged' && e.brandId === b.brandId),
    ).toBe(true)
  })

  it('is due again at the next sign-in while any item remains', async () => {
    const b = await makeBrand()
    await waiting(b.brandId)
    await makeOverdue()
    await ack(b.approver, b.brandId, 'review_now')
    expect((await overdue(b.approver, b.brandId)).json.popup.due).toBe(false)
    const second = await signInAgain(b)
    const again = await overdue(second, b.brandId)
    expect(again.json.count).toBe(1)
    expect(again.json.popup).toEqual({ due: true })
    await ack(second, b.brandId, 'later')
    expect((await overdue(second, b.brandId)).json.popup.due).toBe(false)
  })

  it('does not return in the same session unless a new item becomes overdue after the answer', async () => {
    const b = await makeBrand()
    await waiting(b.brandId, 'First')
    await makeOverdue()
    await ack(b.approver, b.brandId, 'later')
    expect((await overdue(b.approver, b.brandId)).json.popup.due).toBe(false)
    await waiting(b.brandId, 'Second')
    await makeOverdue()
    const now = await overdue(b.approver, b.brandId)
    expect(now.json.count).toBe(2)
    expect(now.json.popup).toEqual({ due: true })
  })

  it('drops an item once it is decided, or superseded', async () => {
    const b = await makeBrand()
    const first = await waiting(b.brandId, 'A')
    const second = await waiting(b.brandId, 'B')
    await makeOverdue()
    expect((await overdue(b.approver, b.brandId)).json.count).toBe(2)
    const approved = await b.approver.request(
      'POST',
      `/api/v1/brands/${b.brandId}/content/${first.item}/versions/${first.versionId}/approve`,
      { body: { hash: first.hash, hash_scheme: 'cv1' } },
    )
    expect(approved.status).toBe(201)
    const one = await overdue(b.approver, b.brandId)
    expect(one.json.count).toBe(1)
    expect(one.json.items[0].versionId).toBe(second.versionId)
    await withBrand(stack.appPool, b.brandId, async (client) => {
      await moveState(client, deps(), second.versionId, 'superseded', { kind: 'system' }, 'superseded')
      await client.query('update app.approval_request set closed_at = now() where content_version_id = $1', [
        second.versionId,
      ])
    })
    expect((await overdue(b.approver, b.brandId)).json).toEqual({
      items: [],
      count: 0,
      popup: { due: false },
    })
  })

  it('refuses a viewer and a sales contact, and a bad choice', async () => {
    const b = await makeBrand()
    expect((await overdue(b.viewer, b.brandId)).status).toBe(403)
    expect((await overdue(b.sales, b.brandId)).status).toBe(403)
    expect((await ack(b.viewer, b.brandId, 'later')).status).toBe(403)
    expect((await ack(b.approver, b.brandId, 'never')).status).toBe(400)
    const extra = await b.approver.request('POST', `/api/v1/brands/${b.brandId}/approvals/overdue/ack`, {
      body: { choice: 'later', more: 1 },
    })
    expect(extra.status).toBe(400)
  })

  it('shows another brand nothing of this one', async () => {
    const a = await makeBrand()
    const other = await makeBrand()
    await waiting(a.brandId)
    await makeOverdue()
    expect((await overdue(a.approver, a.brandId)).json.count).toBe(1)
    expect((await overdue(other.approver, a.brandId)).status).toBe(404)
    expect((await overdue(other.approver, other.brandId)).json).toEqual({
      items: [],
      count: 0,
      popup: { due: false },
    })
  })
})
