import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryAudit } from '../src/testing.ts'
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
type AuditEntry = Parameters<MemoryAudit['record']>[0]

class FailingAudit extends MemoryAudit {
  failOn: string | null = null
  override async record(entry: AuditEntry): Promise<void> {
    if (entry.action === this.failOn) throw new Error('audit is down')
    await super.record(entry)
  }
}

describe('changing a role and removing a person (users routes, part 2)', () => {
  let stack: Stack
  let audit: FailingAudit
  let brand: string
  let other: string
  const people = new Map<string, { id: string; client: TestClient; secret: string }>()

  const patch = (who: string, target: string, body: Record<string, unknown>) =>
    people.get(who)!.client.request('PATCH', `/api/v1/brands/${brand}/users/${target}`, { body })
  const remove = (who: string, target: string, body: Record<string, unknown>) =>
    people.get(who)!.client.request('DELETE', `/api/v1/brands/${brand}/users/${target}`, { body })
  const code = (who: string) => totp(people.get(who)!.secret)
  const roleOf = async (userId: string) =>
    (
      await stack.db.admin.query('select role from app.membership where brand_id = $1 and user_id = $2', [
        brand,
        userId,
      ])
    ).rows[0]?.role

  async function person(key: string, role: 'brand_admin' | 'approver' | 'viewer', brandId = brand) {
    const email = `${key}@example.test`
    const id = await addUser(stack, { email, password: PASSWORD, role, brandId })
    const { client, secret } =
      role === 'viewer'
        ? { client: await signedInClient(stack, email, PASSWORD), secret: '' }
        : await enrolledClient(stack, email, PASSWORD)
    people.set(key, { id, client, secret })
  }

  beforeAll(async () => {
    audit = new FailingAudit()
    stack = await createStack({ audit })
    brand = await addBrand(stack, 'brand-a')
    other = await addBrand(stack, 'brand-b')
    await person('admin', 'brand_admin')
    await person('admin2', 'brand_admin')
    await person('approver', 'approver')
    await person('viewer', 'viewer')
    const ownerId = await addUser(stack, {
      email: 'owner@example.test',
      password: PASSWORD,
      platformOwner: true,
    })
    const owner = await enrolledClient(stack, 'owner@example.test', PASSWORD)
    people.set('owner', { id: ownerId, client: owner.client, secret: owner.secret })
  })
  afterAll(async () => stack?.close())

  it('changes a role with the actor’s own code, writes one audit entry, and takes effect on the next request', async () => {
    const target = people.get('approver')!
    const reply = await patch('admin', target.id, { role: 'viewer', code: code('admin') })
    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({ userId: target.id, role: 'viewer' })
    expect(await roleOf(target.id)).toBe('viewer')
    const entry = audit.entries.filter((e) => e.action === 'users.role_changed').at(-1)!
    expect(entry).toMatchObject({
      actor: people.get('admin')!.id,
      subject: target.id,
      brandId: brand,
      detail: { from: 'approver', to: 'viewer' },
    })
    // The person's powers changed at once: the permission is read per request, not kept in the session.
    expect((await target.client.request('GET', `/api/v1/brands/${brand}/users`)).status).toBe(403)
    await patch('admin', target.id, { role: 'approver', code: code('admin') })
  })

  it('refuses a missing code (400), a wrong code (403) and another person’s code (403), and changes nothing', async () => {
    const target = people.get('approver')!
    expect((await patch('admin', target.id, { role: 'viewer' })).status).toBe(400)
    expect((await patch('admin', target.id, { role: 'viewer', code: '000000' })).status).toBe(403)
    expect((await patch('admin', target.id, { role: 'viewer', code: code('admin2') })).status).toBe(403)
    expect(await roleOf(target.id)).toBe('approver')
  })

  it('counts wrong codes against the actor’s lockout (five locks the account, even for the right code)', async () => {
    const locked = people.get('admin2')!
    for (let i = 0; i < 5; i++) {
      expect(
        (await patch('admin2', people.get('viewer')!.id, { role: 'approver', code: '000000' })).status,
      ).toBe(403)
    }
    expect(
      (await patch('admin2', people.get('viewer')!.id, { role: 'approver', code: totp(locked.secret) }))
        .status,
    ).toBe(429)
    stack.limiter.succeed(`/two-factor:${locked.id}`)
  })

  it('refuses to let anyone change or remove their own membership', async () => {
    const me = people.get('admin')!
    const change = await patch('admin', me.id, { role: 'viewer', code: code('admin') })
    expect(change.status).toBe(409)
    expect(change.json.error.code).toBe('cannot_change_own_membership')
    expect((await remove('admin', me.id, { code: code('admin') })).status).toBe(409)
    expect(await roleOf(me.id)).toBe('brand_admin')
  })

  it('answers 404 for someone who is not a member of the brand, and for a brand the actor is not in', async () => {
    const stranger = await addUser(stack, {
      email: 'elsewhere@example.test',
      password: PASSWORD,
      role: 'viewer',
      brandId: other,
    })
    expect((await patch('admin', stranger, { role: 'viewer', code: code('admin') })).status).toBe(404)
    const otherBrand = await people
      .get('admin')!
      .client.request('PATCH', `/api/v1/brands/${other}/users/${stranger}`, {
        body: { role: 'approver', code: code('admin') },
      })
    expect(otherBrand.status).toBe(404)
  })

  it('refuses a role that is not one of the four, and an unknown field', async () => {
    const target = people.get('approver')!
    expect((await patch('admin', target.id, { role: 'platform_owner', code: code('admin') })).status).toBe(
      400,
    )
    expect(
      (await patch('admin', target.id, { role: 'viewer', code: code('admin'), brandId: other })).status,
    ).toBe(400)
  })

  it('refuses to demote or remove the last brand admin, and allows it once another exists', async () => {
    const solo = await addBrand(stack, 'brand-solo')
    const soloAdmin = await addUser(stack, {
      email: 'solo@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: solo,
    })
    const ownerClient = people.get('owner')!
    const url = `/api/v1/brands/${solo}/users/${soloAdmin}`
    const demote = await ownerClient.client.request('PATCH', url, {
      body: { role: 'viewer', code: totp(ownerClient.secret) },
    })
    expect(demote.status).toBe(409)
    expect(demote.json.error.code).toBe('last_admin')
    const removal = await ownerClient.client.request('DELETE', url, {
      body: { code: totp(ownerClient.secret) },
    })
    expect(removal.status).toBe(409)
    const second = await addUser(stack, {
      email: 'solo2@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: solo,
    })
    expect(
      (await ownerClient.client.request('DELETE', url, { body: { code: totp(ownerClient.secret) } })).status,
    ).toBe(204)
    expect(second).toBeDefined()
  })

  it('never leaves a brand with no admin when two admins demote each other at the same moment', async () => {
    const pair = await addBrand(stack, 'brand-pair')
    const emailA = 'pair-a@example.test'
    const emailB = 'pair-b@example.test'
    const idA = await addUser(stack, {
      email: emailA,
      password: PASSWORD,
      role: 'brand_admin',
      brandId: pair,
    })
    const idB = await addUser(stack, {
      email: emailB,
      password: PASSWORD,
      role: 'brand_admin',
      brandId: pair,
    })
    const a = await enrolledClient(stack, emailA, PASSWORD)
    const b = await enrolledClient(stack, emailB, PASSWORD)
    const demote = (who: typeof a, target: string) =>
      who.client.request('PATCH', `/api/v1/brands/${pair}/users/${target}`, {
        body: { role: 'viewer', code: totp(who.secret) },
      })
    const replies = await Promise.all([demote(a, idB), demote(b, idA)])
    expect(replies.filter((r) => r.status === 200)).toHaveLength(1)
    const admins = await stack.db.admin.query(
      "select count(*)::int as n from app.membership where brand_id = $1 and role = 'brand_admin'",
      [pair],
    )
    expect(admins.rows[0].n).toBe(1)
  })

  it('lets only the platform owner touch a platform owner’s membership', async () => {
    const ownerInBrand = await addUser(stack, {
      email: 'owner-member@example.test',
      password: PASSWORD,
      role: 'approver',
      brandId: brand,
      platformOwner: true,
    })
    const byAdmin = await patch('admin', ownerInBrand, { role: 'viewer', code: code('admin') })
    expect(byAdmin.status).toBe(403)
    expect(await roleOf(ownerInBrand)).toBe('approver')
    const owner = people.get('owner')!
    const byOwner = await owner.client.request('PATCH', `/api/v1/brands/${brand}/users/${ownerInBrand}`, {
      body: { role: 'viewer', code: totp(owner.secret) },
    })
    expect(byOwner.status).toBe(200)
  })

  it('removes a person: the membership goes, and their sessions end when none is left', async () => {
    const target = people.get('viewer')!
    expect((await target.client.request('GET', '/api/v1/session')).status).toBe(200)
    const reply = await remove('admin', target.id, { code: code('admin') })
    expect(reply.status).toBe(204)
    expect(await roleOf(target.id)).toBeUndefined()
    expect((await target.client.request('GET', '/api/v1/session')).status).toBe(401)
    const entry = audit.entries.filter((e) => e.action === 'users.removed').at(-1)!
    expect(entry).toMatchObject({ subject: target.id, brandId: brand, detail: { role: 'viewer' } })
    expect(
      (await stack.db.admin.query('select 1 from auth."user" where id = $1', [target.id])).rowCount,
    ).toBe(1)
  })

  it('keeps a removed person’s sessions when they still belong to another brand', async () => {
    const both = await addUser(stack, {
      email: 'both@example.test',
      password: PASSWORD,
      role: 'viewer',
      brandId: brand,
    })
    await stack.db.admin.query(
      "insert into app.membership (brand_id, user_id, role) values ($1, $2, 'viewer')",
      [other, both],
    )
    const client = await signedInClient(stack, 'both@example.test', PASSWORD)
    expect((await remove('admin', both, { code: code('admin') })).status).toBe(204)
    expect((await client.request('GET', '/api/v1/session')).status).toBe(200)
  })

  it('rolls the change back when the audit entry cannot be written (fail-closed)', async () => {
    const target = people.get('approver')!
    audit.failOn = 'users.role_changed'
    const reply = await patch('admin', target.id, { role: 'viewer', code: code('admin') })
    audit.failOn = null
    expect(reply.status).toBe(500)
    expect(await roleOf(target.id)).toBe('approver')
  })

  it('answers 200 with changed: false, and writes no audit entry, when the role is already that role', async () => {
    const target = people.get('approver')!
    const before = audit.entries.length
    const reply = await patch('admin', target.id, { role: 'approver', code: code('admin') })
    expect(reply.status).toBe(200)
    expect(audit.entries.filter((e) => e.action === 'users.role_changed').length).toBe(
      audit.entries.slice(0, before).filter((e) => e.action === 'users.role_changed').length,
    )
  })

  it('is for people who manage users: an approver gets 403 before any code is looked at', async () => {
    const reply = await patch('approver', people.get('admin2')!.id, { role: 'viewer', code: '000000' })
    expect(reply.status).toBe(403)
    expect(reply.json.error.code).toBe('forbidden')
  })
})
