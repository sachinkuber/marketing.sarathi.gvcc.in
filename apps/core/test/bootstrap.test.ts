import { databaseUrl } from '@mkt/test-support'
import { createTestDatabase, type TestDatabase } from '@mkt/db/testing'
import { verifyPassword } from 'better-auth/crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootstrap, parseArguments } from '../src/bootstrap.ts'

// A fixture address; the real owner's address comes from the operator at run time.
const OWNER = 'Owner.Fixture@example.test'

let db: TestDatabase
let adminUrl: string
let firstPassword = ''

beforeAll(async () => {
  db = await createTestDatabase()
  const url = new URL(databaseUrl)
  url.pathname = `/${db.name}`
  adminUrl = url.toString()
}, 120_000)

afterAll(async () => db?.drop())

const q = async (sql: string, params: unknown[] = []) => (await db.admin.query(sql, params)).rows

describe('owner bootstrap (plan decision 11)', () => {
  it('first run: both brands, the owner, two admin memberships and one audit entry; the password is printed once', async () => {
    const printed: string[] = []
    // Everything the process writes while it runs, to prove the password goes to `print` and nowhere else.
    const written: string[] = []
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        written.push(String(chunk))
        return true
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        written.push(String(chunk))
        return true
      }),
    ]
    let result
    try {
      result = await bootstrap({ adminUrl, ownerEmail: OWNER, print: (text) => printed.push(text) })
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(result).toEqual({ created: true })

    expect(await q('select slug, name from app.brand order by slug')).toEqual([
      { slug: 'aztek-global', name: 'Aztek Global' },
      { slug: 'test-brand', name: 'Test brand' },
    ])
    const users = await q(`select id, email from auth."user"`)
    expect(users).toHaveLength(1)
    expect(users[0].email).toBe('owner.fixture@example.test')
    const owners = await q('select user_id from app.platform_owner')
    expect(owners).toEqual([{ user_id: users[0].id }])
    expect(await q('select role from app.membership where user_id = $1', [users[0].id])).toEqual([
      { role: 'brand_admin' },
      { role: 'brand_admin' },
    ])
    const entries = await q(
      `select action, outcome, actor_kind, actor_id, detail from audit.log where action = 'platform.bootstrapped'`,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ outcome: 'success', actor_kind: 'user', actor_id: users[0].id })

    // Printed once: a 24-character random password that the stored hash matches, and nothing else holds it.
    expect(printed).toHaveLength(1)
    const password = printed[0]!
    firstPassword = password
    expect(password).toMatch(/^[A-Za-z0-9_-]{24}$/)
    const stored = await q(`select password from auth.account where "userId" = $1`, [users[0].id])
    expect(stored).toHaveLength(1)
    expect(stored[0].password).not.toContain(password)
    expect(written.join('')).not.toContain(password)
    for (const table of ['audit.log', 'auth.account', 'auth."user"', 'app.brand', 'app.membership']) {
      const dump = JSON.stringify(await q(`select * from ${table}`))
      if (table !== 'auth.account') expect(dump).not.toContain(password)
    }
    expect(JSON.stringify(entries)).not.toContain(password)
  })

  it('the printed password is the one the stored hash verifies', async () => {
    const { rows } = await db.admin.query(`select password from auth.account`)
    expect(await verifyPassword({ hash: String(rows[0].password), password: firstPassword })).toBe(true)
    expect(await verifyPassword({ hash: String(rows[0].password), password: 'not the password' })).toBe(false)
  })

  it('second run changes nothing, prints nothing and returns created: false', async () => {
    const before = {
      users: await q(`select id from auth."user"`),
      brands: await q('select id from app.brand order by slug'),
      members: await q('select id from app.membership order by id'),
      audit: await q(`select count(*)::int as n from audit.log where action = 'platform.bootstrapped'`),
      account: await q(`select password from auth.account`),
    }
    const printed: string[] = []
    const result = await bootstrap({ adminUrl, ownerEmail: OWNER, print: (text) => printed.push(text) })
    expect(result).toEqual({ created: false })
    expect(printed).toEqual([])
    expect(await q(`select id from auth."user"`)).toEqual(before.users)
    expect(await q('select id from app.brand order by slug')).toEqual(before.brands)
    expect(await q('select id from app.membership order by id')).toEqual(before.members)
    expect(
      await q(`select count(*)::int as n from audit.log where action = 'platform.bootstrapped'`),
    ).toEqual(before.audit)
    expect(await q(`select password from auth.account`)).toEqual(before.account)
  })

  it('a brand that already exists is kept, not duplicated, when the owner is created later', async () => {
    const other = await createTestDatabase()
    try {
      await other.admin.query(`select app.create_brand('Aztek Global', 'aztek-global')`)
      const url = new URL(databaseUrl)
      url.pathname = `/${other.name}`
      const printed: string[] = []
      const result = await bootstrap({
        adminUrl: url.toString(),
        ownerEmail: 'someone@example.test',
        print: (text) => printed.push(text),
      })
      expect(result).toEqual({ created: true })
      expect(printed).toHaveLength(1)
      expect((await other.admin.query('select slug from app.brand order by slug')).rows).toEqual([
        { slug: 'aztek-global' },
        { slug: 'test-brand' },
      ])
    } finally {
      await other.drop()
    }
  })

  it('a user who exists without owner rights is refused with a clear message, and nothing is changed', async () => {
    const other = await createTestDatabase()
    try {
      await other.admin.query(
        `insert into auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         values ('11111111-1111-4111-8111-111111111111', 'x', 'plain@example.test', true, now(), now())`,
      )
      const url = new URL(databaseUrl)
      url.pathname = `/${other.name}`
      const printed: string[] = []
      await expect(
        bootstrap({
          adminUrl: url.toString(),
          ownerEmail: 'plain@example.test',
          print: (t) => printed.push(t),
        }),
      ).rejects.toThrow(/without owner rights/)
      expect(printed).toEqual([])
      expect((await other.admin.query('select 1 from app.platform_owner')).rowCount).toBe(0)
    } finally {
      await other.drop()
    }
  })

  it('refuses an address that is not an email, before touching the database', async () => {
    const printed: string[] = []
    await expect(
      bootstrap({
        adminUrl: 'postgres://unused.invalid/none',
        ownerEmail: 'not-an-address',
        print: (t) => printed.push(t),
      }),
    ).rejects.toThrow('owner email')
    expect(printed).toEqual([])
  })
})

describe('bootstrap command line', () => {
  it('prints a leftover-user message from a failed grant instead of only its name', async () => {
    const { isKnownMessage } = await import('../src/bootstrap.ts')
    expect(isKnownMessage('bootstrap: user abc left behind after a failed grant')).toBe(true)
    expect(isKnownMessage('The owner email is not a valid address.')).toBe(true)
    expect(isKnownMessage('connect ECONNREFUSED 10.0.0.1')).toBe(false)
  })

  it('takes the address from --owner-email, or from OWNER_EMAIL', () => {
    expect(parseArguments(['--owner-email', 'a@example.test'], {})).toEqual({ ownerEmail: 'a@example.test' })
    expect(parseArguments(['--owner-email=b@example.test'], {})).toEqual({ ownerEmail: 'b@example.test' })
    expect(parseArguments([], { OWNER_EMAIL: 'c@example.test' })).toEqual({ ownerEmail: 'c@example.test' })
  })

  it('refuses a missing address and unknown arguments', () => {
    expect(() => parseArguments([], {})).toThrow('--owner-email')
    expect(() => parseArguments(['--owner-email', 'a@example.test', '--force'], {})).toThrow(
      'Unknown argument',
    )
  })

  it('does not echo the unknown argument value', () => {
    let message = ''
    try {
      parseArguments(['--password=hunter2-secret'], {})
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('Unknown argument')
    expect(message).not.toContain('hunter2')
  })
})
