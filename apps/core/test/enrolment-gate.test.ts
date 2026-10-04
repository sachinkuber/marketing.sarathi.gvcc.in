import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { needsSecondFactor } from '../src/auth/session.ts'
import { addBrand, addUser, createStack, type Stack } from './support.ts'

describe('who needs a second factor', () => {
  it('exempts only a user whose every membership is Viewer', () => {
    expect(needsSecondFactor(false, [{ role: 'viewer' }])).toBe(false)
    expect(needsSecondFactor(false, [{ role: 'viewer' }, { role: 'viewer' }])).toBe(false)
  })

  it('requires one for every other role, for a viewer who is also an approver elsewhere, and for no memberships', () => {
    for (const role of ['brand_admin', 'approver', 'sales_contact'] as const) {
      expect(needsSecondFactor(false, [{ role }])).toBe(true)
    }
    expect(needsSecondFactor(false, [{ role: 'viewer' }, { role: 'approver' }])).toBe(true)
    expect(needsSecondFactor(false, [])).toBe(true)
    expect(needsSecondFactor(true, [])).toBe(true)
    expect(needsSecondFactor(true, [{ role: 'viewer' }])).toBe(true)
  })
})

describe('sign-in and the enrolment gate (acceptance test 8)', () => {
  let stack: Stack
  let brand: string
  const PASSWORD = 'correct horse battery'

  beforeAll(async () => {
    stack = await createStack()
    // A route behind the gate, standing in for every real one.
    stack.core.api.get('/test-protected', (_req, res) => {
      res.json({ ok: true })
    })
    brand = await addBrand(stack, 'brand-a')
    await addUser(stack, {
      email: 'approver@example.test',
      password: PASSWORD,
      role: 'approver',
      brandId: brand,
    })
    await addUser(stack, { email: 'viewer@example.test', password: PASSWORD, role: 'viewer', brandId: brand })
    await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
  })
  afterAll(async () => stack.close())

  it('answers 401 to a protected route with no session', async () => {
    const res = await stack.newClient().request('GET', '/api/v1/test-protected')
    expect(res.status).toBe(401)
    expect(res.json.error.code).toBe('not_signed_in')
  })

  it('lets an approver sign in but reach nothing except enrolment until a second factor is set', async () => {
    const client = stack.newClient()
    const signIn = await client.signIn('approver@example.test', PASSWORD)
    expect(signIn.status).toBe(200)
    const session = await client.request('GET', '/api/v1/session')
    expect(session.status).toBe(200)
    expect(session.json).toMatchObject({
      user: { email: 'approver@example.test' },
      twoFactorEnabled: false,
      needsSecondFactor: true,
      enrolmentRequired: true,
      platformOwner: false,
      memberships: [{ brandId: brand, role: 'approver' }],
    })
    const blocked = await client.request('GET', '/api/v1/test-protected')
    expect(blocked.status).toBe(403)
    expect(blocked.json.error.code).toBe('enrolment_required')
  })

  it('treats a platform owner with no brand as needing a second factor', async () => {
    const client = stack.newClient()
    await client.signIn('owner@example.test', PASSWORD)
    const blocked = await client.request('GET', '/api/v1/test-protected')
    expect(blocked.status).toBe(403)
    expect(blocked.json.error.code).toBe('enrolment_required')
    expect((await client.request('GET', '/api/v1/session')).json.platformOwner).toBe(true)
  })

  it('lets a Viewer in with email and password only', async () => {
    const client = stack.newClient()
    expect((await client.signIn('viewer@example.test', PASSWORD)).status).toBe(200)
    const session = await client.request('GET', '/api/v1/session')
    expect(session.json).toMatchObject({ needsSecondFactor: false, enrolmentRequired: false })
    expect((await client.request('GET', '/api/v1/test-protected')).status).toBe(200)
  })

  it('gives the same error for a wrong password and an unknown email', async () => {
    const wrong = await stack.newClient().signIn('viewer@example.test', 'not the password!')
    const unknown = await stack.newClient().signIn('nobody@example.test', 'not the password!')
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(wrong.status)
    expect(unknown.json).toEqual(wrong.json)
  })

  it('has no self-registration', async () => {
    const client = stack.newClient()
    const res = await client.request('POST', '/api/auth/sign-up/email', {
      body: { email: 'new@example.test', name: 'New', password: PASSWORD },
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    const count = await stack.db.admin.query(
      'select count(*)::int as n from auth."user" where email = \'new@example.test\'',
    )
    expect(count.rows[0].n).toBe(0)
  })

  it('sets a secure, http-only, same-site session cookie', async () => {
    const client = stack.newClient()
    const res = await client.request('POST', '/api/auth/sign-in/email', {
      body: { email: 'viewer@example.test', password: PASSWORD },
    })
    const cookie = res.setCookies.find((line) => /session_token/.test(line)) ?? ''
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).toMatch(/Secure/i)
  })

  it('refuses a sign-in from another origin, and a write with no session token (acceptance test 12)', async () => {
    const other = await stack.newClient().request('POST', '/api/auth/sign-in/email', {
      body: { email: 'viewer@example.test', password: PASSWORD },
      origin: 'https://evil.example.test',
    })
    expect(other.status).toBe(403)
    const client = stack.newClient()
    await client.signIn('viewer@example.test', PASSWORD)
    const noToken = await client.request('POST', '/api/auth/sign-out', { csrf: false })
    expect(noToken.status).toBe(403)
    expect(noToken.json.error.code).toBe('bad_csrf_token')
    expect((await client.request('POST', '/api/auth/sign-out')).status).toBe(200)
    expect((await client.request('GET', '/api/v1/session')).status).toBe(401)
  })
})
