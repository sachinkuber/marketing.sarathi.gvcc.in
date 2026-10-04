import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryAudit, MemoryMailer, ThrowingMailer } from '../src/testing.ts'
import {
  ORIGIN,
  addBrand,
  addUser,
  createStack,
  enrolledClient,
  tokenFromMail,
  type Stack,
  type TestClient,
} from './support.ts'

const PASSWORD = 'correct horse battery'

// An audit that is down for the invite entry only.
class FailingAudit extends MemoryAudit {
  override async record(entry: Parameters<MemoryAudit['record']>[0]): Promise<void> {
    if (entry.action === 'users.invited') throw new Error('audit is down')
    await super.record(entry)
  }
}

describe('listing people and inviting (users routes, part 1)', () => {
  let stack: Stack
  let brandA: string
  let brandB: string
  let admin: TestClient
  let approver: TestClient
  let owner: TestClient

  const invite = (client: TestClient, brand: string, body: unknown) =>
    client.request('POST', `/api/v1/brands/${brand}/users/invites`, { body })

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
    await addUser(stack, {
      email: 'approver@example.test',
      password: PASSWORD,
      role: 'approver',
      brandId: brandA,
    })
    await addUser(stack, {
      email: 'b-admin@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brandB,
    })
    await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
    admin = (await enrolledClient(stack, 'admin@example.test', PASSWORD)).client
    approver = (await enrolledClient(stack, 'approver@example.test', PASSWORD)).client
    owner = (await enrolledClient(stack, 'owner@example.test', PASSWORD)).client
  })
  afterAll(async () => stack?.close())

  it('lists the people of the brand and nobody else, with no secret in the answer', async () => {
    const reply = await admin.request('GET', `/api/v1/brands/${brandA}/users`)
    expect(reply.status).toBe(200)
    expect(reply.json.members.map((m: { email: string }) => m.email).sort()).toEqual([
      'admin@example.test',
      'approver@example.test',
    ])
    const admins = reply.json.members.find((m: { email: string }) => m.email === 'admin@example.test')
    expect(admins).toMatchObject({ role: 'brand_admin', twoFactorEnabled: true, name: 'admin' })
    expect(reply.text).not.toMatch(/token|hash|password/i)
    expect(reply.text).not.toContain('b-admin@example.test')
  })

  it('is for brand admins and the platform owner only', async () => {
    expect((await approver.request('GET', `/api/v1/brands/${brandA}/users`)).status).toBe(403)
    expect((await owner.request('GET', `/api/v1/brands/${brandA}/users`)).status).toBe(200)
    expect((await admin.request('GET', `/api/v1/brands/${brandB}/users`)).status).toBe(404)
  })

  it('invites a person: 201, no token in the answer, the link goes to the person, and it is audited', async () => {
    const before = stack.mailer.sent.length
    const reply = await invite(admin, brandA, { email: 'New.Person@Example.test', role: 'approver' })
    expect(reply.status).toBe(201)
    expect(Object.keys(reply.json).sort()).toEqual(['expiresAt', 'id'])
    const mail = stack.mailer.sent[before]!
    expect(mail.to).toBe('new.person@example.test')
    expect(mail.text).toContain(`${ORIGIN}/accept-invite?token=`)
    expect(reply.text).not.toContain(tokenFromMail(mail))
    const entry = stack.audit.entries.filter((e) => e.action === 'users.invited').at(-1)!
    expect(entry).toMatchObject({
      outcome: 'success',
      brandId: brandA,
      detail: { role: 'approver', inviteId: reply.json.id },
    })
    expect(JSON.stringify(entry)).not.toContain('example.test')
  })

  it('shows the invite as pending with its expiry, and the invited person can then accept it', async () => {
    const list = await admin.request('GET', `/api/v1/brands/${brandA}/users`)
    const pending = list.json.pendingInvites.find(
      (i: { email: string }) => i.email === 'new.person@example.test',
    )
    expect(pending).toMatchObject({ role: 'approver', expired: false })
    expect(new Date(pending.expiresAt).getTime()).toBeGreaterThan(Date.now())
    const token = tokenFromMail(stack.mailer.sent.at(-1)!)
    const accept = await stack.newClient().request('POST', '/api/v1/invites/accept', {
      body: { token, name: 'New Person', password: PASSWORD },
    })
    expect(accept.status).toBe(201)
    const after = await admin.request('GET', `/api/v1/brands/${brandA}/users`)
    expect(after.json.pendingInvites).toEqual([])
    expect(after.json.members.map((m: { email: string }) => m.email)).toContain('new.person@example.test')
  })

  it('lets only people who manage users invite, only into their own brand, and never as a platform owner', async () => {
    expect((await invite(approver, brandA, { email: 'x@example.test', role: 'viewer' })).status).toBe(403)
    expect((await invite(admin, brandB, { email: 'x@example.test', role: 'viewer' })).status).toBe(404)
    expect((await invite(admin, brandA, { email: 'x@example.test', role: 'platform_owner' })).status).toBe(
      400,
    )
    expect((await invite(owner, brandB, { email: 'from-owner@example.test', role: 'viewer' })).status).toBe(
      201,
    )
  })

  it('refuses a bad email, an unknown field, and a missing role before anything is written', async () => {
    const count = async () =>
      (await stack.db.admin.query('select count(*)::int as n from app.invite')).rows[0].n
    const before = await count()
    expect((await invite(admin, brandA, { email: 'not-an-email', role: 'viewer' })).status).toBe(400)
    expect(
      (await invite(admin, brandA, { email: 'a@example.test', role: 'viewer', brandId: brandB })).status,
    ).toBe(400)
    expect((await invite(admin, brandA, { email: 'a@example.test' })).status).toBe(400)
    expect(await count()).toBe(before)
  })

  it('uses the configured origin for the link, whatever the request says about its host', async () => {
    const before = stack.mailer.sent.length
    await admin.request('POST', `/api/v1/brands/${brandA}/users/invites`, {
      body: { email: 'host@example.test', role: 'viewer' },
      headers: { 'x-forwarded-host': 'evil.example.test', host: 'evil.example.test' },
    })
    expect(stack.mailer.sent[before]!.text).toContain(`${ORIGIN}/accept-invite?token=`)
    expect(stack.mailer.sent[before]!.text).not.toContain('evil.example.test')
  })
})

describe('inviting when mail cannot be sent, or the audit cannot be written', () => {
  it('answers 502 and leaves no invite behind when the mail fails, and reports it', async () => {
    const mailer = new ThrowingMailer()
    const stack = await createStack({ mailer })
    try {
      const brand = await addBrand(stack, 'brand-m')
      await addUser(stack, {
        email: 'admin@example.test',
        password: PASSWORD,
        role: 'brand_admin',
        brandId: brand,
      })
      const { client } = await enrolledClient(stack, 'admin@example.test', PASSWORD)
      const reply = await client.request('POST', `/api/v1/brands/${brand}/users/invites`, {
        body: { email: 'x@example.test', role: 'viewer' },
      })
      expect(reply.status).toBe(502)
      expect(reply.json.error.code).toBe('mail_not_sent')
      expect((await stack.db.admin.query('select count(*)::int as n from app.invite')).rows[0].n).toBe(0)
      expect(stack.logs.join('')).toContain('mail not sent')
      expect(stack.logs.join('')).not.toContain('x@example.test')
    } finally {
      await stack.close()
    }
  })

  it('rolls the invite back, and sends no mail, when the audit entry cannot be written (fail-closed)', async () => {
    const mailer = new MemoryMailer()
    const stack = await createStack({ mailer, audit: new FailingAudit() })
    try {
      const brand = await addBrand(stack, 'brand-f')
      await addUser(stack, {
        email: 'admin@example.test',
        password: PASSWORD,
        role: 'brand_admin',
        brandId: brand,
      })
      const { client } = await enrolledClient(stack, 'admin@example.test', PASSWORD)
      const before = mailer.sent.length
      const reply = await client.request('POST', `/api/v1/brands/${brand}/users/invites`, {
        body: { email: 'x@example.test', role: 'viewer' },
      })
      expect(reply.status).toBe(500)
      expect((await stack.db.admin.query('select count(*)::int as n from app.invite')).rows[0].n).toBe(0)
      expect(mailer.sent.length).toBe(before)
    } finally {
      await stack.close()
    }
  })
})
