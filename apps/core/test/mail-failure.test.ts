import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { HangingMailer, ThrowingMailer } from '../src/testing.ts'
import { addBrand, addUser, createStack, enrol, type Stack } from './support.ts'

const PASSWORD = 'correct horse battery'

// Mail fails open: a notification that cannot be sent is reported to the log and never changes the
// answer a person gets (Review Focus 5). The audit sink is not covered here; it stays fail-closed.
describe('a mail transport that is down', () => {
  let stack: Stack
  let mailer: ThrowingMailer
  let brand: string

  const mailFailures = () => stack.logs.filter((line) => line.includes('mail not sent'))

  beforeAll(async () => {
    mailer = new ThrowingMailer()
    stack = await createStack({ mailer })
    brand = await addBrand(stack, 'brand-a')
  })
  afterAll(async () => stack?.close())

  it('gives the same answer for a known and an unknown address, and reports the failure once', async () => {
    await addUser(stack, { email: 'known@example.test', password: PASSWORD, role: 'viewer', brandId: brand })
    const before = mailFailures().length
    const known = await stack
      .newClient()
      .request('POST', '/api/auth/request-password-reset', { body: { email: 'known@example.test' } })
    const unknown = await stack
      .newClient()
      .request('POST', '/api/auth/request-password-reset', { body: { email: 'nobody@example.test' } })
    expect(known.status).toBe(200)
    expect(unknown.status).toBe(200)
    expect(unknown.text).toBe(known.text)
    expect(mailer.attempts).toBe(1)
    // The send is not awaited, so the report follows the answer.
    await vi.waitFor(() => expect(mailFailures().length - before).toBe(1))
    const reported = mailFailures().slice(before)
    expect(reported).toHaveLength(1)
    expect(reported[0]).not.toContain('known@example.test')
    expect(reported[0]).not.toContain('reset-password')
  })

  it('signs in with a backup code, records it, and the code is still used up', async () => {
    await addUser(stack, {
      email: 'backup@example.test',
      password: PASSWORD,
      role: 'approver',
      brandId: brand,
    })
    const first = stack.newClient()
    await first.signIn('backup@example.test', PASSWORD)
    const { backupCodes } = await enrol(first, PASSWORD)
    const before = mailFailures().length

    const client = stack.newClient()
    expect((await client.signIn('backup@example.test', PASSWORD)).json.twoFactorRedirect).toBe(true)
    const used = await client.request('POST', '/api/auth/two-factor/verify-backup-code', {
      body: { code: backupCodes[0] },
    })
    expect(used.status).toBe(200)
    expect(used.setCookies.some((line) => /session_token=[^;]+/.test(line))).toBe(true)
    expect(
      stack.audit.entries.filter((e) => e.action === 'auth.backup_code_used' && e.outcome === 'success'),
    ).toHaveLength(1)
    expect(mailFailures().slice(before)).toHaveLength(1)
    expect(mailFailures().join('\n')).not.toContain('backup@example.test')

    const again = stack.newClient()
    await again.signIn('backup@example.test', PASSWORD)
    const reuse = await again.request('POST', '/api/auth/two-factor/verify-backup-code', {
      body: { code: backupCodes[0] },
    })
    expect(reuse.status).toBe(401)
  })
})

// The reset mail is sent without waiting for it, so how long the answer takes does not tell a person whether
// an address has an account (the 2b mail-timing follow-up).
describe('a mail transport that never answers', () => {
  let stack: Stack
  let mailer: HangingMailer

  beforeAll(async () => {
    mailer = new HangingMailer()
    stack = await createStack({ mailer })
    const brand = await addBrand(stack, 'brand-hang')
    await addUser(stack, { email: 'known@example.test', password: PASSWORD, role: 'viewer', brandId: brand })
  })
  afterAll(async () => stack?.close())

  it('does not hold the response to a reset request for a known or an unknown address', async () => {
    const ask = (email: string) =>
      Promise.race([
        stack
          .newClient()
          .request('POST', '/api/auth/request-password-reset', { body: { email } })
          .then((r) => r.status),
        new Promise<string>((resolve) => setTimeout(() => resolve('held'), 5_000)),
      ])
    expect(await ask('known@example.test')).toBe(200)
    expect(await ask('nobody@example.test')).toBe(200)
    // Only the known address had mail to send, and it is still pending.
    expect(mailer.attempts).toBe(1)
  }, 15_000)
})
