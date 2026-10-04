import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from '@mkt/db'
import { acceptInvite, createInvite } from '../src/auth/invites.ts'
import type { Auth } from '../src/auth/options.ts'
import { createUserWithPassword } from '../src/auth/users.ts'
import { ORIGIN, addBrand, addUser, createStack, tokenFromMail, type Stack } from './support.ts'

const PASSWORD = 'a long enough password'

describe('invites (acceptance test 11)', () => {
  let stack: Stack
  let brand: string
  let admin: string

  beforeAll(async () => {
    stack = await createStack()
    brand = await addBrand(stack, 'brand-a')
    admin = await addUser(stack, {
      email: 'admin@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brand,
    })
  })
  afterAll(async () => stack.close())

  async function invite(email: string, role: 'approver' | 'viewer' = 'approver') {
    const before = stack.mailer.sent.length
    const created = await createInvite(stack.appPool, stack.mailer, {
      brandId: brand,
      email,
      role,
      invitedBy: admin,
      origin: ORIGIN,
    })
    expect(stack.mailer.sent.length).toBe(before + 1)
    const message = stack.mailer.sent[before]!
    return { created, message, token: tokenFromMail(message) }
  }

  const accept = (client = stack.newClient(), body: Record<string, unknown>) =>
    client.request('POST', '/api/v1/invites/accept', { body })

  it('emails the link to the invitee and stores only a hash of the token', async () => {
    const { created, message, token } = await invite('one@example.test')
    expect(message.to).toBe('one@example.test')
    expect(message.text).toContain(`${ORIGIN}/accept-invite?token=`)
    const row = await stack.db.admin.query('select * from app.invite where id = $1', [created.id])
    expect(JSON.stringify(row.rows[0])).not.toContain(token)
    expect(row.rows[0].token_hash).toBeInstanceOf(Buffer)
    expect(row.rows[0].token_hash.length).toBe(32)
  })

  it('expires 72 hours after it was made', async () => {
    const { created } = await invite('two@example.test')
    const row = await stack.db.admin.query(
      'select extract(epoch from (expires_at - created_at)) as seconds from app.invite where id = $1',
      [created.id],
    )
    expect(Number(row.rows[0].seconds)).toBe(72 * 3600)
  })

  it('shows the invitee their email, role and brand without a session', async () => {
    const { token } = await invite('look@example.test', 'viewer')
    const res = await stack.newClient().request('POST', '/api/v1/invites/lookup', { body: { token } })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ email: 'look@example.test', role: 'viewer', brandName: 'brand-a' })
  })

  it('creates the account and membership on acceptance, and the person can then sign in', async () => {
    const { token } = await invite('accepted@example.test')
    const res = await accept(undefined, { token, name: 'Ada', password: PASSWORD })
    expect(res.status).toBe(201)
    const member = await stack.db.admin.query(
      'select m.role, m.created_by from app.membership m where m.user_id = $1 and m.brand_id = $2',
      [res.json.userId, brand],
    )
    expect(member.rows).toEqual([{ role: 'approver', created_by: admin }])
    expect((await stack.newClient().signIn('accepted@example.test', PASSWORD)).status).toBe(200)
  })

  it('refuses a second use of the same invite', async () => {
    const { token } = await invite('once@example.test')
    expect((await accept(undefined, { token, name: 'A', password: PASSWORD })).status).toBe(201)
    const again = await accept(undefined, { token, name: 'A', password: 'another long password' })
    expect(again.status).toBe(410)
    expect(again.json.error.code).toBe('invite_invalid')
  })

  it('refuses an expired invite and gives the same answer as an unknown token', async () => {
    const { created, token } = await invite('late@example.test')
    await stack.db.admin.query(
      "update app.invite set expires_at = now() - interval '1 second' where id = $1",
      [created.id],
    )
    const late = await accept(undefined, { token, name: 'L', password: PASSWORD })
    expect(late.status).toBe(410)
    const unknown = await accept(undefined, { token: 'x'.repeat(43), name: 'L', password: PASSWORD })
    expect(unknown.status).toBe(410)
    expect(unknown.json).toEqual(late.json)
    const users = await stack.db.admin.query(
      'select count(*)::int as n from auth."user" where email = \'late@example.test\'',
    )
    expect(users.rows[0].n).toBe(0)
  })

  it('produces exactly one account and one membership when the invite is accepted twice at once', async () => {
    const { token } = await invite('race@example.test')
    const replies = await Promise.all([
      accept(stack.newClient(), { token, name: 'R', password: PASSWORD }),
      accept(stack.newClient(), { token, name: 'R', password: PASSWORD }),
    ])
    expect(replies.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1)
    // Observed 6 of 6 runs: the loser fails on the unique email, which the account helper maps to 409.
    const loser = replies.find((r) => r.status !== 201)!
    expect(loser.status).toBe(409)
    expect(loser.json.error.code).toBe('account_exists')
    const users = await stack.db.admin.query('select id from auth."user" where email = \'race@example.test\'')
    expect(users.rows).toHaveLength(1)
    const members = await stack.db.admin.query(
      'select count(*)::int as n from app.membership where user_id = $1',
      [users.rows[0].id],
    )
    expect(members.rows[0].n).toBe(1)
  })

  it('refuses an invite for an email that already has an account, and does not use the invite up', async () => {
    await addUser(stack, { email: 'existing@example.test', password: PASSWORD })
    const { token } = await invite('existing@example.test')
    const res = await accept(undefined, { token, name: 'E', password: PASSWORD })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('account_exists')
    const peek = await stack.newClient().request('POST', '/api/v1/invites/lookup', { body: { token } })
    expect(peek.status).toBe(200)
  })

  it('refuses a short password and an unknown field before touching the invite', async () => {
    const { token } = await invite('short@example.test')
    expect((await accept(undefined, { token, name: 'S', password: 'short' })).status).toBe(400)
    expect(
      (await accept(undefined, { token, name: 'S', password: PASSWORD, role: 'brand_admin' })).status,
    ).toBe(400)
    expect(
      (await stack.newClient().request('POST', '/api/v1/invites/lookup', { body: { token } })).status,
    ).toBe(200)
  })

  // The account is made before the invite is redeemed, so these break the redeem (or the clean-up)
  // after the account exists and check what is left behind.
  describe('when a step fails after the account is made', () => {
    const accountsFor = async (email: string) =>
      (await stack.db.admin.query('select id from auth."user" where email = $1', [email])).rows.length

    // A pool that answers the invite check for real and runs `onRedeem` in place of the redeem.
    function poolWithRedeem(onRedeem: (text: string, values: unknown[]) => Promise<unknown>): Pool {
      return {
        query: (text: string, values: unknown[]) =>
          text.includes('redeem_invite') ? onRedeem(text, values) : stack.appPool.query(text, values),
      } as unknown as Pool
    }

    async function authWith(override: Record<string, unknown>): Promise<Auth> {
      const context = await stack.core.auth.$context
      return {
        $context: Promise.resolve({
          ...context,
          internalAdapter: { ...context.internalAdapter, ...override },
        }),
      } as unknown as Auth
    }

    it('removes the account when the invite expires between the check and the redeem', async () => {
      const { created, token } = await invite('between@example.test')
      const pool = poolWithRedeem(async (text, values) => {
        await stack.db.admin.query(
          "update app.invite set expires_at = now() - interval '1 second' where id = $1",
          [created.id],
        )
        return stack.appPool.query(text, values)
      })
      await expect(
        acceptInvite(stack.core.auth, pool, { token, name: 'B', password: PASSWORD }),
      ).rejects.toMatchObject({
        status: 410,
        code: 'invite_invalid',
      })
      expect(await accountsFor('between@example.test')).toBe(0)
    })

    it('removes the account and passes the original error on when the redeem fails another way', async () => {
      const { token } = await invite('broken@example.test')
      const failure = new Error('redeem broke')
      const pool = poolWithRedeem(async () => {
        throw failure
      })
      await expect(
        acceptInvite(stack.core.auth, pool, { token, name: 'B', password: PASSWORD }),
      ).rejects.toBe(failure)
      expect(await accountsFor('broken@example.test')).toBe(0)
    })

    it('names the account left behind when removing it fails too', async () => {
      const { token } = await invite('stuck@example.test')
      const failure = new Error('redeem broke')
      const pool = poolWithRedeem(async () => {
        throw failure
      })
      const auth = await authWith({
        deleteUser: async () => {
          throw new Error('delete broke')
        },
      })
      const error = await acceptInvite(auth, pool, { token, name: 'S', password: PASSWORD }).catch((e) => e)
      const [row] = (
        await stack.db.admin.query('select id from auth."user" where email = $1', ['stuck@example.test'])
      ).rows
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toContain(row.id)
      expect(error.message).toContain('left behind')
      expect(error.cause).toBe(failure)
    })

    it('removes the account when linking the password fails, and passes the original error on', async () => {
      const failure = new Error('link broke')
      const auth = await authWith({
        linkAccount: async () => {
          throw failure
        },
      })
      await expect(
        createUserWithPassword(auth, { email: 'nolink@example.test', name: 'N', password: PASSWORD }),
      ).rejects.toBe(failure)
      expect(await accountsFor('nolink@example.test')).toBe(0)
    })

    it('names the account left behind when linking and removing both fail', async () => {
      const failure = new Error('link broke')
      const auth = await authWith({
        linkAccount: async () => {
          throw failure
        },
        deleteUser: async () => {
          throw new Error('delete broke')
        },
      })
      const error = await createUserWithPassword(auth, {
        email: 'halfmade@example.test',
        name: 'H',
        password: PASSWORD,
      }).catch((e) => e)
      const [row] = (
        await stack.db.admin.query('select id from auth."user" where email = $1', ['halfmade@example.test'])
      ).rows
      expect(error.message).toContain(row.id)
      expect(error.cause).toBe(failure)
    })
  })

  it('refuses an accept from another origin', async () => {
    const { token } = await invite('origin@example.test')
    const res = await stack.newClient().request('POST', '/api/v1/invites/accept', {
      body: { token, name: 'O', password: PASSWORD },
      origin: 'https://evil.example.test',
    })
    expect(res.status).toBe(403)
  })
})
