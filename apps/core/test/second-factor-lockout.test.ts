import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBrand, addUser, createStack, enrol, totp, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
const EMAIL = 'guarded@example.test'
let clock = 9_000_000
const advance = (ms: number) => void (clock += ms)

describe('second-factor guessing, recovery requests and invite lookups are bounded and audited', () => {
  let stack: Stack
  let secret: string
  let backupCode: string

  beforeAll(async () => {
    stack = await createStack({ now: () => clock })
    const brand = await addBrand(stack, 'brand-a')
    await addUser(stack, { email: EMAIL, password: PASSWORD, role: 'approver', brandId: brand })
    await addUser(stack, { email: 'known@example.test', password: PASSWORD, role: 'viewer', brandId: brand })
    const client = stack.newClient()
    await client.signIn(EMAIL, PASSWORD)
    const enrolled = await enrol(client, PASSWORD)
    secret = enrolled.secret
    backupCode = enrolled.backupCodes[0]!
  })
  afterAll(async () => stack.close())

  let junk = 0
  // A bad code with a different junk cookie each time, as someone trying to dodge a per-cookie count would.
  const guess = (client: TestClient, code = '000000') =>
    client.request('POST', '/api/auth/two-factor/verify-totp', {
      body: { code },
      headers: { cookie: `junk${++junk}=${junk}` },
    })

  it('counts bad codes per account across separate sign-ins and extra cookies, and a correct password does not reset it', async () => {
    const first = stack.newClient()
    expect((await first.signIn(EMAIL, PASSWORD)).json.twoFactorRedirect).toBe(true)
    for (let i = 0; i < 3; i++) expect((await guess(first)).status).toBeGreaterThanOrEqual(400)
    const second = stack.newClient()
    // Entering the right password again between guesses must not clear the count.
    expect((await second.signIn(EMAIL, PASSWORD)).json.twoFactorRedirect).toBe(true)
    for (let i = 0; i < 2; i++) expect((await guess(second)).status).toBeGreaterThanOrEqual(400)

    const third = stack.newClient()
    expect((await third.signIn(EMAIL, PASSWORD)).json.twoFactorRedirect).toBe(true)
    const before = stack.audit.entries.length
    const locked = await guess(third, totp(secret))
    expect(locked.status).toBe(429)
    // Refused before the code was looked at: the backup route shares the lock, and no second-factor
    // success was recorded for the right code.
    const viaBackup = await third.request('POST', '/api/auth/two-factor/verify-backup-code', {
      body: { code: backupCode },
    })
    expect(viaBackup.status).toBe(429)
    const added = stack.audit.entries.slice(before)
    expect(added.some((e) => e.action === 'auth.second_factor' && e.outcome === 'success')).toBe(false)
    expect(added.some((e) => e.action === 'auth.locked_out')).toBe(true)
  })

  it('frees the account when the lock ends, and a correct code then clears it', async () => {
    advance(16 * 60_000)
    const client = stack.newClient()
    await client.signIn(EMAIL, PASSWORD)
    expect((await guess(client, totp(secret))).status).toBe(200)
  })

  it('limits reset requests per address, the same for a known and an unknown address, and sends no mail once refused', async () => {
    const request = (email: string) =>
      stack.newClient().request('POST', '/api/auth/request-password-reset', { body: { email } })
    const bodies: unknown[] = []
    for (const email of ['known@example.test', 'nobody@example.test']) {
      for (let i = 0; i < 5; i++) expect((await request(email)).status).toBe(200)
      const mails = stack.mailer.sent.length
      const refused = await request(email)
      expect(refused.status).toBe(429)
      expect(stack.mailer.sent.length).toBe(mails)
      bodies.push(refused.json)
    }
    expect(bodies[0]).toEqual(bodies[1])
    const entries = stack.audit.entries.filter(
      (e) =>
        e.action === 'auth.locked_out' && (e.detail as { path?: string })?.path === '/request-password-reset',
    )
    expect(entries.length).toBeGreaterThanOrEqual(2)
    for (const entry of entries) expect(entry.detail).toMatchObject({ emailHash: expect.any(String) })
    expect(JSON.stringify(stack.audit.entries)).not.toContain('example.test')
  })

  it('audits invite lookups that fail and those that are refused', async () => {
    const lookup = () =>
      stack.newClient().request('POST', '/api/v1/invites/lookup', { body: { token: 'y'.repeat(43) } })
    for (let i = 0; i < 5; i++) expect((await lookup()).status).toBe(410)
    expect(
      stack.audit.entries.filter((e) => e.action === 'auth.invite_lookup' && e.outcome === 'failure'),
    ).toHaveLength(5)
    expect((await lookup()).status).toBe(429)
    expect(
      stack.audit.entries.some(
        (e) => e.action === 'auth.locked_out' && (e.detail as { path?: string })?.path === '/invites/lookup',
      ),
    ).toBe(true)
  })
})
