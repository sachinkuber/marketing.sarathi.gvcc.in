import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createInvite } from '../src/auth/invites.ts'
import { ORIGIN, addBrand, addUser, createStack, type Stack } from './support.ts'

const PASSWORD = 'correct horse battery'
let clock = 5_000_000
const advance = (ms: number) => void (clock += ms)

describe('rate limits, lockout and the audit of every attempt', () => {
  let stack: Stack
  let brand: string

  beforeAll(async () => {
    stack = await createStack({ now: () => clock })
    brand = await addBrand(stack, 'brand-a')
    await addUser(stack, { email: 'victim@example.test', password: PASSWORD, role: 'viewer', brandId: brand })
    await addUser(stack, {
      email: 'bystander@example.test',
      password: PASSWORD,
      role: 'viewer',
      brandId: brand,
    })
  })
  afterAll(async () => stack.close())

  const wrong = (email: string) => stack.newClient().signIn(email, 'not the password!')

  it('locks an address after five wrong passwords, even for the right one, and frees it after 15 minutes', async () => {
    for (let i = 0; i < 5; i++) expect((await wrong('victim@example.test')).status).toBe(401)
    const count = (action: string) => stack.audit.entries.filter((e) => e.action === action).length
    const signIns = count('auth.sign_in')
    const lockedOut = count('auth.locked_out')
    const locked = await stack.newClient().signIn('victim@example.test', PASSWORD)
    expect(locked.status).toBe(429)
    // Exactly one entry for the refused attempt: the refusal, not also a failed sign-in.
    expect(count('auth.sign_in')).toBe(signIns)
    expect(count('auth.locked_out')).toBe(lockedOut + 1)
    advance(14 * 60_000)
    expect((await stack.newClient().signIn('victim@example.test', PASSWORD)).status).toBe(429)
    advance(61_000)
    expect((await stack.newClient().signIn('victim@example.test', PASSWORD)).status).toBe(200)
  })

  it('does not lock anyone else', async () => {
    expect((await stack.newClient().signIn('bystander@example.test', PASSWORD)).status).toBe(200)
  })

  it('shares one lock between capital and lower-case spellings', async () => {
    for (let i = 0; i < 5; i++) await wrong(i % 2 ? 'BYSTANDER@example.test' : 'bystander@example.test')
    expect((await stack.newClient().signIn('Bystander@Example.test', PASSWORD)).status).toBe(429)
    advance(16 * 60_000)
  })

  it('locks an address that has no account in the same way, so lockout reveals nothing', async () => {
    const first = await wrong('ghost@example.test')
    for (let i = 0; i < 4; i++) await wrong('ghost@example.test')
    const locked = await wrong('ghost@example.test')
    expect(first.status).toBe(401)
    expect(locked.status).toBe(429)
    const real = await (async () => {
      for (let i = 0; i < 5; i++) await wrong('victim@example.test')
      return wrong('victim@example.test')
    })()
    expect(real.status).toBe(429)
    expect(real.json).toEqual(locked.json)
    advance(16 * 60_000)
  })

  it('audits every attempt, with a hash of the address and never the address or the password', async () => {
    const entries = stack.audit.entries
    expect(entries.some((e) => e.action === 'auth.sign_in' && e.outcome === 'failure')).toBe(true)
    expect(entries.some((e) => e.action === 'auth.sign_in' && e.outcome === 'success')).toBe(true)
    expect(entries.some((e) => e.action === 'auth.locked_out')).toBe(true)
    const text = JSON.stringify(entries)
    expect(text).not.toContain('example.test')
    expect(text).not.toContain(PASSWORD)
    expect(text).not.toContain('not the password')
    expect(entries.find((e) => e.action === 'auth.sign_in')!.detail).toMatchObject({
      emailHash: expect.any(String),
    })
  })

  it('limits invite acceptance by address of the caller, and audits it', async () => {
    const admin = await addUser(stack, {
      email: 'admin@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brand,
    })
    await createInvite(stack.appPool, stack.mailer, {
      brandId: brand,
      email: 'new@example.test',
      role: 'viewer',
      invitedBy: admin,
      origin: ORIGIN,
    })
    const guess = () =>
      stack.newClient().request('POST', '/api/v1/invites/accept', {
        body: { token: 'x'.repeat(43), name: 'G', password: PASSWORD },
      })
    for (let i = 0; i < 5; i++) expect((await guess()).status).toBe(410)
    expect((await guess()).status).toBe(429)
    expect(
      stack.audit.entries.some((e) => e.action === 'auth.invite_accepted' && e.outcome === 'failure'),
    ).toBe(true)
  })
})
