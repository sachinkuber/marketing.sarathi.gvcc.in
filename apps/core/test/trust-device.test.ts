import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBrand, addUser, createStack, enrol, totp, type Stack } from './support.ts'

const PASSWORD = 'correct horse battery'
const EMAIL = 'trusted@example.test'

// SEC-1 and spec 7: every sign-in asks for the second factor. The library's "remember this device"
// flag would skip it for 30 days from that browser, so it is refused.
describe('no remembered devices (SEC-1)', () => {
  let stack: Stack
  let secret: string
  let codes: string[]

  beforeAll(async () => {
    stack = await createStack()
    const brand = await addBrand(stack, 'brand-a')
    await addUser(stack, { email: EMAIL, password: PASSWORD, role: 'approver', brandId: brand })
    const client = stack.newClient()
    await client.signIn(EMAIL, PASSWORD)
    ;({ secret, backupCodes: codes } = await enrol(client, PASSWORD))
  })
  afterAll(async () => stack?.close())

  for (const route of ['verify-totp', 'verify-backup-code'] as const) {
    it(`refuses trustDevice on ${route}, sets no trust cookie, and the next sign-in still asks`, async () => {
      const client = stack.newClient()
      expect((await client.signIn(EMAIL, PASSWORD)).json.twoFactorRedirect).toBe(true)
      const code = route === 'verify-totp' ? totp(secret) : codes[0]
      const reply = await client.request('POST', `/api/auth/two-factor/${route}`, {
        body: { code, trustDevice: true },
      })
      expect(reply.status).toBe(403)
      expect(reply.setCookies.filter((line) => /trust_device/.test(line))).toEqual([])
      // Same browser, same cookie jar: the password alone is still not enough.
      const again = await client.signIn(EMAIL, PASSWORD)
      expect(again.status).toBe(200)
      expect(again.json.twoFactorRedirect).toBe(true)
    })
  }

  it('still accepts the same steps without the flag', async () => {
    const client = stack.newClient()
    await client.signIn(EMAIL, PASSWORD)
    const ok = await client.request('POST', '/api/auth/two-factor/verify-totp', {
      body: { code: totp(secret), trustDevice: false },
    })
    expect(ok.status).toBe(200)
    expect(ok.setCookies.filter((line) => /trust_device/.test(line))).toEqual([])
  })
})
