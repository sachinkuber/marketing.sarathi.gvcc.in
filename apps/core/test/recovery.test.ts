import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBrand, addUser, createStack, enrol, tokenFromMail, type Stack } from './support.ts'

const OLD = 'the old password!!'
const NEW = 'a brand new password'

describe('password recovery (acceptance test 10)', () => {
  let stack: Stack
  let brand: string

  beforeAll(async () => {
    stack = await createStack()
    brand = await addBrand(stack, 'brand-a')
  })
  afterAll(async () => stack.close())

  async function request(email: string) {
    const before = stack.mailer.sent.length
    const res = await stack
      .newClient()
      .request('POST', '/api/auth/request-password-reset', { body: { email } })
    return { res, mails: stack.mailer.sent.slice(before) }
  }

  it('answers the same for an address with no account, and sends nothing', async () => {
    await addUser(stack, { email: 'known@example.test', password: OLD, role: 'viewer', brandId: brand })
    const known = await request('known@example.test')
    const unknown = await request('nobody@example.test')
    expect(known.res.status).toBe(200)
    expect(unknown.res.status).toBe(known.res.status)
    expect(unknown.res.json).toEqual(known.res.json)
    expect(known.mails).toHaveLength(1)
    expect(known.mails[0]!.to).toBe('known@example.test')
    expect(unknown.mails).toHaveLength(0)
  })

  it('lasts 30 minutes', async () => {
    await addUser(stack, { email: 'time@example.test', password: OLD, role: 'viewer', brandId: brand })
    await request('time@example.test')
    const row = await stack.db.admin.query(
      `select extract(epoch from ("expiresAt" - "createdAt")) as seconds from auth.verification order by "createdAt" desc limit 1`,
    )
    expect(Number(row.rows[0].seconds)).toBeGreaterThanOrEqual(30 * 60 - 2)
    expect(Number(row.rows[0].seconds)).toBeLessThanOrEqual(30 * 60 + 2)
  })

  it('works once: the new password signs in, the old one does not, the same link is then refused', async () => {
    await addUser(stack, { email: 'once@example.test', password: OLD, role: 'viewer', brandId: brand })
    const { mails } = await request('once@example.test')
    const token = tokenFromMail(mails[0]!)
    const client = stack.newClient()
    const reset = await client.request('POST', '/api/auth/reset-password', {
      body: { newPassword: NEW, token },
    })
    expect(reset.status).toBe(200)
    expect(reset.setCookies.some((c) => /session_token/.test(c))).toBe(false)
    expect((await stack.newClient().signIn('once@example.test', OLD)).status).toBe(401)
    expect((await stack.newClient().signIn('once@example.test', NEW)).status).toBe(200)
    const again = await client.request('POST', '/api/auth/reset-password', {
      body: { newPassword: 'yet another one!!', token },
    })
    expect(again.status).toBeGreaterThanOrEqual(400)
  })

  it('is refused after it expires', async () => {
    await addUser(stack, { email: 'late@example.test', password: OLD, role: 'viewer', brandId: brand })
    const { mails } = await request('late@example.test')
    await stack.db.admin.query(`update auth.verification set "expiresAt" = now() - interval '1 second'`)
    const res = await stack.newClient().request('POST', '/api/auth/reset-password', {
      body: { newPassword: NEW, token: tokenFromMail(mails[0]!) },
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await stack.newClient().signIn('late@example.test', OLD)).status).toBe(200)
  })

  it('ends every existing session', async () => {
    await addUser(stack, { email: 'sessions@example.test', password: OLD, role: 'viewer', brandId: brand })
    const open = stack.newClient()
    await open.signIn('sessions@example.test', OLD)
    expect((await open.request('GET', '/api/v1/session')).status).toBe(200)
    const { mails } = await request('sessions@example.test')
    await stack.newClient().request('POST', '/api/auth/reset-password', {
      body: { newPassword: NEW, token: tokenFromMail(mails[0]!) },
    })
    expect((await open.request('GET', '/api/v1/session')).status).toBe(401)
  })

  it('still asks for the second factor after a reset', async () => {
    await addUser(stack, { email: 'second@example.test', password: OLD, role: 'approver', brandId: brand })
    const first = stack.newClient()
    await first.signIn('second@example.test', OLD)
    await enrol(first, OLD)
    const { mails } = await request('second@example.test')
    await stack.newClient().request('POST', '/api/auth/reset-password', {
      body: { newPassword: NEW, token: tokenFromMail(mails[0]!) },
    })
    const next = stack.newClient()
    const signIn = await next.signIn('second@example.test', NEW)
    expect(signIn.json.twoFactorRedirect).toBe(true)
    expect((await next.request('GET', '/api/v1/session')).status).toBe(401)
  })

  it('refuses a new password that is too short', async () => {
    await addUser(stack, { email: 'weak@example.test', password: OLD, role: 'viewer', brandId: brand })
    const { mails } = await request('weak@example.test')
    const res = await stack.newClient().request('POST', '/api/auth/reset-password', {
      body: { newPassword: 'short', token: tokenFromMail(mails[0]!) },
    })
    expect(res.status).toBe(400)
  })

  it('puts no reset token in anything it audits', async () => {
    const text = JSON.stringify(stack.audit.entries)
    expect(text).not.toMatch(/token/i)
  })
})
