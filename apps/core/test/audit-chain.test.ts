import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryAudit } from '../src/testing.ts'
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

interface Person {
  id: string
  client: TestClient
  secret: string
}

async function enrolled(
  stack: Stack,
  key: string,
  role: 'brand_admin' | 'approver',
  brandId: string,
): Promise<Person> {
  const email = `${key}@example.test`
  const id = await addUser(stack, { email, password: PASSWORD, role, brandId })
  const { client, secret } = await enrolledClient(stack, email, PASSWORD)
  return { id, client, secret }
}

async function owner(stack: Stack): Promise<Person> {
  const id = await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
  const { client, secret } = await enrolledClient(stack, 'owner@example.test', PASSWORD)
  return { id, client, secret }
}

const patchRole = (who: Person, brand: string, target: string, role: string) =>
  who.client.request('PATCH', `/api/v1/brands/${brand}/users/${target}`, {
    body: { role, code: totp(who.secret) },
  })
const removeUser = (who: Person, brand: string, target: string) =>
  who.client.request('DELETE', `/api/v1/brands/${brand}/users/${target}`, {
    body: { code: totp(who.secret) },
  })
const invite = (who: Person, brand: string, email: string) =>
  who.client.request('POST', `/api/v1/brands/${brand}/users/invites`, { body: { email, role: 'viewer' } })
const resetSecondFactor = (who: Person, target: string) =>
  who.client.request('POST', `/api/v1/users/${target}/second-factor/reset`, {
    body: { code: totp(who.secret) },
  })

describe('each change-bound audit call carries its transaction (in memory)', () => {
  it('passes the transaction for an invite, a role change, a removal and a second-factor reset', async () => {
    const audit = new MemoryAudit()
    const stack = await createStack({ audit })
    try {
      const brand = await addBrand(stack, 'brand-a')
      const admin = await enrolled(stack, 'admin', 'brand_admin', brand)
      const mover = await enrolled(stack, 'mover', 'approver', brand)
      const leaver = await enrolled(stack, 'leaver', 'approver', brand)
      const victim = await enrolled(stack, 'victim', 'approver', brand)
      const platform = await owner(stack)
      expect((await invite(admin, brand, 'new@example.test')).status).toBe(201)
      expect((await patchRole(admin, brand, mover.id, 'viewer')).status).toBe(200)
      expect((await removeUser(admin, brand, leaver.id)).status).toBe(204)
      expect((await resetSecondFactor(platform, victim.id)).status).toBe(204)
      const wanted = ['users.invited', 'users.role_changed', 'users.removed', 'users.second_factor_reset']
      for (const action of wanted) {
        const at = audit.entries.findIndex((entry) => entry.action === action)
        expect(at, action).toBeGreaterThanOrEqual(0)
        expect(audit.transactional[at], action).toBe(true)
      }
    } finally {
      await stack.close()
    }
  })
})

describe('with the database audit sink', () => {
  let stack: Stack
  let brand: string
  let admin: Person
  let target: Person
  let platform: Person

  const chain = async (key: string, like: string) =>
    (
      await stack.db.admin.query(
        'select action, actor_id, subject from audit.log where chain_key = $1 and action like $2 order by seq',
        [key, like],
      )
    ).rows
  const roleOf = async (userId: string) =>
    (
      await stack.db.admin.query('select role from app.membership where brand_id = $1 and user_id = $2', [
        brand,
        userId,
      ])
    ).rows[0]?.role
  const APPEND = 'audit.append(uuid, app.actor_kind, uuid, text, text, text, jsonb)'

  beforeAll(async () => {
    stack = await createStack({ realAudit: true })
    brand = await addBrand(stack, 'brand-a')
    admin = await enrolled(stack, 'admin', 'brand_admin', brand)
    target = await enrolled(stack, 'target', 'approver', brand)
    platform = await owner(stack)
  })
  afterAll(async () => stack?.close())

  it('puts an invite, a role change and a removal on the brand chain, a second-factor reset on the platform chain, and the chains verify', async () => {
    expect((await invite(admin, brand, 'new@example.test')).status).toBe(201)
    expect((await patchRole(admin, brand, target.id, 'viewer')).status).toBe(200)
    const leaver = await enrolled(stack, 'leaver', 'approver', brand)
    expect((await removeUser(admin, brand, leaver.id)).status).toBe(204)
    expect((await resetSecondFactor(platform, target.id)).status).toBe(204)

    const brandEntries = await chain(brand, 'users.%')
    expect(brandEntries.map((r) => r.action)).toEqual([
      'users.invited',
      'users.role_changed',
      'users.removed',
    ])
    expect(brandEntries[1]).toMatchObject({ actor_id: admin.id, subject: target.id })
    const platformEntries = await chain('platform', 'users.%')
    expect(platformEntries.map((r) => r.action)).toEqual(['users.second_factor_reset'])
    for (const key of [brand, 'platform']) {
      const verdict = await stack.db.admin.query('select ok from audit.verify_chain($1)', [key])
      expect(verdict.rows[0].ok, key).toBe(true)
    }
  })

  it('undoes a role change when its audit entry cannot be written (Review Focus 8)', async () => {
    const mover = await enrolled(stack, 'mover', 'approver', brand)
    await stack.db.admin.query(`revoke execute on function ${APPEND} from mkt_app`)
    try {
      const reply = await patchRole(admin, brand, mover.id, 'viewer')
      expect(reply.status).toBe(500)
      expect(await roleOf(mover.id)).toBe('approver')
    } finally {
      await stack.db.admin.query(`grant execute on function ${APPEND} to mkt_app`)
    }
    expect((await patchRole(admin, brand, mover.id, 'viewer')).status).toBe(200)
    expect(await roleOf(mover.id)).toBe('viewer')
  })

  it('undoes an invite when its audit entry cannot be written, and sends no mail', async () => {
    const mailBefore = stack.mailer.sent.length
    await stack.db.admin.query(`revoke execute on function ${APPEND} from mkt_app`)
    try {
      const reply = await invite(admin, brand, 'ghost@example.test')
      expect(reply.status).toBe(500)
    } finally {
      await stack.db.admin.query(`grant execute on function ${APPEND} to mkt_app`)
    }
    const rows = await stack.db.admin.query(
      "select count(*)::int as n from app.invite where email = 'ghost@example.test'",
    )
    expect(rows.rows[0].n).toBe(0)
    expect(stack.mailer.sent.length).toBe(mailBefore)
  })
})
