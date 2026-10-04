import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BACKUP_CODE_COUNT } from '../src/auth/policy.ts'
import { addBrand, addUser, createStack, enrol, totp, type Stack } from './support.ts'

const PASSWORD = 'correct horse battery'
const EMAIL = 'approver@example.test'

describe('second factor and backup codes (acceptance test 9, SEC-1)', () => {
  let stack: Stack
  let secret: string
  let codes: string[]

  beforeAll(async () => {
    stack = await createStack()
    stack.core.api.get('/test-protected', (_req, res) => {
      res.json({ ok: true })
    })
    const brand = await addBrand(stack, 'brand-a')
    await addUser(stack, { email: EMAIL, password: PASSWORD, role: 'approver', brandId: brand })
  })
  afterAll(async () => stack.close())

  it('enrols: shows backup codes once, and opens the gate only after the code is confirmed', async () => {
    const client = stack.newClient()
    await client.signIn(EMAIL, PASSWORD)
    const enable = await client.request('POST', '/api/auth/two-factor/enable', {
      body: { password: PASSWORD },
    })
    expect(enable.status).toBe(200)
    expect(enable.json.backupCodes).toHaveLength(BACKUP_CODE_COUNT)
    secret = new URL(enable.json.totpURI).searchParams.get('secret') as string
    codes = enable.json.backupCodes
    // Not confirmed yet, so the gate is still closed.
    expect((await client.request('GET', '/api/v1/test-protected')).status).toBe(403)
    const wrong = await client.request('POST', '/api/auth/two-factor/verify-totp', {
      body: { code: '000000' },
    })
    expect(wrong.status).toBeGreaterThanOrEqual(400)
    expect((await client.request('GET', '/api/v1/test-protected')).status).toBe(403)
    const right = await client.request('POST', '/api/auth/two-factor/verify-totp', {
      body: { code: totp(secret) },
    })
    expect(right.status).toBe(200)
    await client.refreshCsrf()
    expect((await client.request('GET', '/api/v1/test-protected')).status).toBe(200)
    expect((await client.request('GET', '/api/v1/session')).json.twoFactorEnabled).toBe(true)
  })

  it('does not store backup codes in the clear', async () => {
    const stored = await stack.db.admin.query('select "backupCodes" from auth."twoFactor"')
    for (const code of codes) expect(JSON.stringify(stored.rows)).not.toContain(code)
  })

  it('asks for the code after the password, and gives no session before it', async () => {
    const client = stack.newClient()
    const signIn = await client.signIn(EMAIL, PASSWORD)
    expect(signIn.status).toBe(200)
    expect(signIn.json.twoFactorRedirect).toBe(true)
    expect((await client.request('GET', '/api/v1/session')).status).toBe(401)
    const verify = await client.request('POST', '/api/auth/two-factor/verify-totp', {
      body: { code: totp(secret) },
    })
    expect(verify.status).toBe(200)
    await client.refreshCsrf()
    expect((await client.request('GET', '/api/v1/test-protected')).status).toBe(200)
  })

  it('accepts a backup code once, audits and notifies it, and refuses it the second time', async () => {
    const before = stack.mailer.sent.length
    const first = stack.newClient()
    expect((await first.signIn(EMAIL, PASSWORD)).json.twoFactorRedirect).toBe(true)
    const used = await first.request('POST', '/api/auth/two-factor/verify-backup-code', {
      body: { code: codes[0] },
    })
    expect(used.status).toBe(200)
    const success = stack.audit.entries.filter(
      (e) => e.action === 'auth.backup_code_used' && e.outcome === 'success',
    )
    expect(success).toHaveLength(1)
    expect(success[0]!.actor).toMatch(/^[0-9a-f-]{36}$/)
    const mail = stack.mailer.sent.slice(before).find((m) => /backup code/i.test(m.subject))
    expect(mail?.to).toBe(EMAIL)

    const second = stack.newClient()
    await second.signIn(EMAIL, PASSWORD)
    const again = await second.request('POST', '/api/auth/two-factor/verify-backup-code', {
      body: { code: codes[0] },
    })
    expect(again.status).toBeGreaterThanOrEqual(400)
    expect(
      stack.audit.entries.some((e) => e.action === 'auth.backup_code_used' && e.outcome === 'failure'),
    ).toBe(true)
    const other = await second.request('POST', '/api/auth/two-factor/verify-backup-code', {
      body: { code: codes[1] },
    })
    expect(other.status).toBe(200)
  })

  it('keeps no code, password or secret in what it audits or emails', async () => {
    const text = JSON.stringify([stack.audit.entries, stack.mailer.sent])
    for (const value of [PASSWORD, secret, ...codes]) expect(text).not.toContain(value)
  })

  it('refuses to turn the second factor off, for anyone (SEC-1)', async () => {
    const client = stack.newClient()
    await client.signIn(EMAIL, PASSWORD)
    await client.request('POST', '/api/auth/two-factor/verify-totp', {
      body: { code: totp(secret, Date.now() + 30_000) },
    })
    await client.refreshCsrf()
    const off = await client.request('POST', '/api/auth/two-factor/disable', { body: { password: PASSWORD } })
    expect(off.status).toBe(403)
    expect((await client.request('GET', '/api/v1/session')).json.twoFactorEnabled).toBe(true)
  })

  it('can run the whole enrolment through the helper for a second person', async () => {
    const brand = await addBrand(stack, 'brand-b')
    await addUser(stack, {
      email: 'admin-b@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brand,
    })
    const client = stack.newClient()
    await client.signIn('admin-b@example.test', PASSWORD)
    const enrolled = await enrol(client, PASSWORD)
    expect(enrolled.backupCodes).toHaveLength(BACKUP_CODE_COUNT)
    expect((await client.request('GET', '/api/v1/test-protected')).status).toBe(200)
  })
})
