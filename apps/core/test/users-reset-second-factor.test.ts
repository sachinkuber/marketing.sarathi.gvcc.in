import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryAudit, ThrowingMailer } from '../src/testing.ts'
import {
  addBrand,
  addUser,
  createStack,
  enrol,
  enrolledClient,
  signedInClient,
  totp,
  type Stack,
  type TestClient,
} from './support.ts'

const PASSWORD = 'correct horse battery'
const RANDOM = '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b'
type AuditEntry = Parameters<MemoryAudit['record']>[0]

class FailingAudit extends MemoryAudit {
  override async record(entry: AuditEntry): Promise<void> {
    if (entry.action === 'users.second_factor_reset') throw new Error('audit is down')
    await super.record(entry)
  }
}

describe('resetting a second factor (the platform owner, with their own code)', () => {
  let stack: Stack
  let brand: string
  let owner: { client: TestClient; secret: string }
  let ownerId: string
  let admin: { client: TestClient; secret: string }
  let victimId: string
  let victim: TestClient

  const reset = (client: TestClient, target: string, body: Record<string, unknown>) =>
    client.request('POST', `/api/v1/users/${target}/second-factor/reset`, { body })

  beforeAll(async () => {
    stack = await createStack({ audit: new MemoryAudit() })
    brand = await addBrand(stack, 'brand-a')
    ownerId = await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
    await addUser(stack, {
      email: 'admin@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brand,
    })
    victimId = await addUser(stack, {
      email: 'victim@example.test',
      password: PASSWORD,
      role: 'approver',
      brandId: brand,
    })
    owner = await enrolledClient(stack, 'owner@example.test', PASSWORD)
    admin = await enrolledClient(stack, 'admin@example.test', PASSWORD)
    victim = (await enrolledClient(stack, 'victim@example.test', PASSWORD)).client
  })
  afterAll(async () => stack?.close())

  it('answers 401 without a session and 403 enrolment_required before enrolment', async () => {
    const anonymous = await reset(stack.newClient(), victimId, { code: '000000' })
    expect(anonymous.status).toBe(401)
    await addUser(stack, {
      email: 'fresh@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brand,
    })
    const fresh = await signedInClient(stack, 'fresh@example.test', PASSWORD)
    const gated = await reset(fresh, victimId, { code: '000000' })
    expect(gated.status).toBe(403)
    expect(gated.json.error.code).toBe('enrolment_required')
  })

  it('is for the platform owner only: a brand admin gets 403 before any code is looked at', async () => {
    const reply = await reset(admin.client, victimId, { code: '000000' })
    expect(reply.status).toBe(403)
    expect(reply.json.error.code).toBe('forbidden')
    expect(
      (await stack.db.admin.query('select 1 from auth."twoFactor" where "userId" = $1', [victimId])).rowCount,
    ).toBe(1)
  })

  it('refuses a missing, wrong or another person’s code, and changes nothing', async () => {
    expect((await reset(owner.client, victimId, {})).status).toBe(400)
    expect((await reset(owner.client, victimId, { code: '000000' })).status).toBe(403)
    expect((await reset(owner.client, victimId, { code: totp(admin.secret) })).status).toBe(403)
    expect(
      (await stack.db.admin.query('select 1 from auth."twoFactor" where "userId" = $1', [victimId])).rowCount,
    ).toBe(1)
  })

  it('refuses a reset of yourself, and answers 404 for someone who does not exist', async () => {
    const self = await reset(owner.client, ownerId, { code: totp(owner.secret) })
    expect(self.status).toBe(409)
    expect(self.json.error.code).toBe('cannot_reset_own_second_factor')
    expect((await reset(owner.client, RANDOM, { code: totp(owner.secret) })).status).toBe(404)
  })

  it('resets: the secret and backup codes are gone, sessions end, the person is told, and it is audited', async () => {
    const before = stack.mailer.sent.length
    const reply = await reset(owner.client, victimId, { code: totp(owner.secret) })
    expect(reply.status).toBe(204)
    expect(
      (await stack.db.admin.query('select 1 from auth."twoFactor" where "userId" = $1', [victimId])).rowCount,
    ).toBe(0)
    const flag = await stack.db.admin.query(
      'select "twoFactorEnabled" as on from auth."user" where id = $1',
      [victimId],
    )
    expect(flag.rows[0].on).toBe(false)
    expect((await victim.request('GET', '/api/v1/session')).status).toBe(401)
    const mail = stack.mailer.sent.slice(before).find((m) => m.to === 'victim@example.test')
    expect(mail?.subject).toMatch(/second factor/i)
    const entry = stack.audit.entries.filter((e) => e.action === 'users.second_factor_reset').at(-1)!
    expect(entry).toMatchObject({ actor: ownerId, subject: victimId, outcome: 'success' })
    expect(JSON.stringify(stack.audit.entries)).not.toContain('victim@example.test')
  })

  it('makes the next sign-in need enrolment again: password only, then the gate, then a new second factor', async () => {
    const client = stack.newClient()
    const signIn = await client.signIn('victim@example.test', PASSWORD)
    expect(signIn.status).toBe(200)
    expect(signIn.json.twoFactorRedirect).toBeUndefined()
    const session = await client.request('GET', '/api/v1/session')
    expect(session.json).toMatchObject({ twoFactorEnabled: false, enrolmentRequired: true })
    expect((await client.request('GET', '/api/v1/brands')).json.error.code).toBe('enrolment_required')
    await enrol(client, PASSWORD)
    expect((await client.request('GET', '/api/v1/brands')).status).toBe(200)
  })

  it('rolls the reset back when the audit entry cannot be written (fail-closed)', async () => {
    const failing = await createStack({ audit: new FailingAudit() })
    try {
      const b = await addBrand(failing, 'brand-f')
      await addUser(failing, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
      const target = await addUser(failing, {
        email: 'target@example.test',
        password: PASSWORD,
        role: 'approver',
        brandId: b,
      })
      const o = await enrolledClient(failing, 'owner@example.test', PASSWORD)
      await enrolledClient(failing, 'target@example.test', PASSWORD)
      const reply = await o.client.request('POST', `/api/v1/users/${target}/second-factor/reset`, {
        body: { code: totp(o.secret) },
      })
      expect(reply.status).toBe(500)
      expect(
        (await failing.db.admin.query('select 1 from auth."twoFactor" where "userId" = $1', [target]))
          .rowCount,
      ).toBe(1)
    } finally {
      await failing.close()
    }
  })

  it('still resets when the notification cannot be sent, and reports it', async () => {
    const noMail = await createStack({ mailer: new ThrowingMailer() })
    try {
      const b = await addBrand(noMail, 'brand-n')
      await addUser(noMail, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
      const target = await addUser(noMail, {
        email: 'target@example.test',
        password: PASSWORD,
        role: 'viewer',
        brandId: b,
      })
      await signedInClient(noMail, 'target@example.test', PASSWORD)
      const o = await enrolledClient(noMail, 'owner@example.test', PASSWORD)
      const reply = await o.client.request('POST', `/api/v1/users/${target}/second-factor/reset`, {
        body: { code: totp(o.secret) },
      })
      expect(reply.status).toBe(204)
      expect(noMail.logs.join('')).toContain('mail not sent')
    } finally {
      await noMail.close()
    }
  })
})
