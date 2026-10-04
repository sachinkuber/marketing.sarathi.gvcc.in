import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBrand, addUser, createStack, enrol, totp, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
const EMAIL = 'holder@example.test'

// SEC-1: no route, spelling or direct library call turns the second factor off for a person, and the
// emailed one-time code can never stand in for the authenticator app.
describe('no other way to turn the second factor off (SEC-1)', () => {
  let stack: Stack
  let secret: string
  let client: TestClient
  // The plugin's endpoints are not in the inferred type of auth.api (the options are widened), so the
  // direct calls go through this narrow view of it.
  function libraryCall(name: string) {
    const api = stack.core.auth.api as unknown as Record<
      string,
      (input: { body: unknown; headers: Headers }) => Promise<unknown>
    >
    return api[name]!
  }

  async function signedIn(): Promise<TestClient> {
    const next = stack.newClient()
    await next.signIn(EMAIL, PASSWORD)
    const verify = await next.request('POST', '/api/auth/two-factor/verify-totp', {
      body: { code: totp(secret) },
    })
    if (verify.status !== 200) throw new Error(`verify failed: ${verify.status} ${verify.text}`)
    await next.refreshCsrf()
    return next
  }

  async function stillOn(): Promise<void> {
    const row = await stack.db.admin.query(
      'select "twoFactorEnabled" as on from auth."user" where email = $1',
      [EMAIL],
    )
    expect(row.rows[0].on).toBe(true)
    const factors = await stack.db.admin.query('select count(*)::int as n from auth."twoFactor"')
    expect(factors.rows[0].n).toBe(1)
    expect((await stack.newClient().signIn(EMAIL, PASSWORD)).json.twoFactorRedirect).toBe(true)
  }

  beforeAll(async () => {
    stack = await createStack()
    const brand = await addBrand(stack, 'brand-a')
    await addUser(stack, { email: EMAIL, password: PASSWORD, role: 'approver', brandId: brand })
    const first = stack.newClient()
    await first.signIn(EMAIL, PASSWORD)
    ;({ secret } = await enrol(first, PASSWORD))
    client = await signedIn()
  })
  afterAll(async () => stack?.close())

  for (const path of [
    '/api/auth/two-factor/disable/',
    '/api/auth/Two-Factor/Disable',
    '/api/auth/TWO-FACTOR/DISABLE/',
  ]) {
    it(`refuses ${path}`, async () => {
      const reply = await client.request('POST', path, { body: { password: PASSWORD } })
      expect([403, 404]).toContain(reply.status)
      await stillOn()
    })
  }

  it('ignores twoFactorEnabled in a profile update', async () => {
    const reply = await client.request('POST', '/api/auth/update-user', {
      body: { twoFactorEnabled: false },
    })
    expect(reply.status).toBeGreaterThanOrEqual(400)
    await stillOn()
  })

  it('refuses a direct library call to turn it off', async () => {
    const holder = await signedIn()
    await expect(
      libraryCall('disableTwoFactor')({
        body: { password: PASSWORD },
        headers: new Headers({ cookie: holder.cookieHeader() }),
      }),
    ).rejects.toMatchObject({ statusCode: 403 })
    await stillOn()
  })

  for (const route of ['send-otp', 'verify-otp'] as const) {
    it(`refuses the emailed one-time code route ${route}, mid sign-in and with a session`, async () => {
      const pending = stack.newClient()
      expect((await pending.signIn(EMAIL, PASSWORD)).json.twoFactorRedirect).toBe(true)
      const body = route === 'send-otp' ? {} : { code: '123456' }
      expect((await pending.request('POST', `/api/auth/two-factor/${route}`, { body })).status).toBe(403)
      expect((await client.request('POST', `/api/auth/two-factor/${route}`, { body })).status).toBe(403)
      await expect(
        libraryCall(route === 'send-otp' ? 'sendTwoFactorOTP' : 'verifyTwoFactorOTP')({
          body,
          headers: new Headers({ cookie: pending.cookieHeader() }),
        }),
      ).rejects.toMatchObject({ statusCode: 403 })
      expect(stack.mailer.sent.filter((m) => /code/i.test(m.subject))).toEqual([])
    })
  }
})
