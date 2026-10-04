import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifySecondFactorCode } from '../src/access/step-up.ts'
import { inputOf, validate } from '../src/validate.ts'
import {
  addBrand,
  addUser,
  createStack,
  enrolledClient,
  totp,
  type Stack,
  type TestClient,
} from './support.ts'

const PASSWORD = 'correct horse battery'
const body = z.strictObject({ code: z.string().regex(/^\d{6}$/) })

describe('asking for the second-factor code before a sensitive action', () => {
  let stack: Stack
  let brand: string
  let admin: TestClient
  let secret: string
  const act = (code: unknown) =>
    admin.request('POST', `/api/v1/brands/${brand}/_probe/step-up`, { body: { code } })

  beforeAll(async () => {
    stack = await createStack({
      extraRoutes: (table, context) => {
        table.add({
          method: 'post',
          path: '/brands/:brandId/_probe/step-up',
          access: { kind: 'permission', permission: 'manage_users' },
          summary: 'probe for the code check',
          handlers: [
            validate({ body }),
            async (req, res) => {
              await verifySecondFactorCode(
                context.auth,
                req,
                inputOf<{ body: { code: string } }>(res).body.code,
              )
              res.json({ ok: true })
            },
          ],
        })
      },
    })
    brand = await addBrand(stack, 'brand-a')
    await addUser(stack, {
      email: 'admin@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brand,
    })
    ;({ client: admin, secret } = await enrolledClient(stack, 'admin@example.test', PASSWORD))
  })
  afterAll(async () => stack?.close())

  it('lets the action through with the signed-in person’s current code', async () => {
    expect((await act(totp(secret))).status).toBe(200)
  })

  it('refuses a missing or malformed code before the check, and a wrong code with 403', async () => {
    expect((await act(undefined)).status).toBe(400)
    expect((await act('12345')).status).toBe(400)
    const wrong = await act('000000')
    expect(wrong.status).toBe(403)
    expect(wrong.json.error.code).toBe('second_factor_invalid')
  })

  it('refuses another person’s code', async () => {
    await addUser(stack, {
      email: 'other@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brand,
    })
    const other = await enrolledClient(stack, 'other@example.test', PASSWORD)
    const reply = await act(totp(other.secret))
    expect(reply.status).toBe(403)
    expect(reply.json.error.code).toBe('second_factor_invalid')
  })

  it('counts wrong codes against the account’s lockout, and then refuses even the right code', async () => {
    // A right code clears the count the earlier tests in this file left, so exactly five wrong ones lock it.
    expect((await act(totp(secret))).status).toBe(200)
    stack.audit.entries.length = 0
    for (let i = 0; i < 5; i++) expect((await act('000000')).status).toBe(403)
    const locked = await act(totp(secret))
    expect(locked.status).toBe(429)
    expect(locked.json.error.code).toBe('too_many_attempts')
    const failures = stack.audit.entries.filter(
      (e) => e.action === 'auth.second_factor' && e.outcome === 'failure',
    )
    expect(failures.length).toBeGreaterThanOrEqual(5)
    expect(JSON.stringify(stack.audit.entries)).not.toContain(secret)
  })
})
