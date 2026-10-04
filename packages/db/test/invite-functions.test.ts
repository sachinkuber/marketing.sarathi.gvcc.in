import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, seedBrand, type RoleName, type TestDatabase } from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const HASH = '\\x' + 'ab'.repeat(32)

async function query(db: TestDatabase, role: RoleName, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: db.urlFor(role) })
  await client.connect()
  try {
    return await client.query(sql, params)
  } finally {
    await client.end()
  }
}

describe('invite functions', () => {
  let db: TestDatabase
  let inviter: string
  let invitee: string

  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    await seedBrand(db, A, 'brand-a')
    inviter = (await db.admin.query('select user_id from app.membership where brand_id = $1', [A])).rows[0]
      .user_id
    invitee = (
      await db.admin.query(
        `insert into auth."user" (name, email, "emailVerified") values ('i','i@example.test',true) returning id`,
      )
    ).rows[0].id
    await db.admin.query(
      `insert into app.invite (brand_id, email, role, token_hash, expires_at, invited_by)
       values ($1, 'i@example.test', 'approver', $2::bytea, now() + interval '72 hours', $3)`,
      [A, HASH, inviter],
    )
  })
  afterAll(async () => db.drop())

  it('shows an unused, unexpired invite and nothing else', async () => {
    const found = await query(db, 'app', 'select * from app.peek_invite($1::bytea)', [HASH])
    expect(found.rows).toEqual([{ email: 'i@example.test', role: 'approver', brand_name: 'brand-a' }])
    const none = await query(db, 'app', 'select * from app.peek_invite($1::bytea)', ['\\x' + 'cd'.repeat(32)])
    expect(none.rows).toEqual([])
  })

  it('redeems once: marks it used, adds the membership, and refuses a second time', async () => {
    const first = await query(db, 'app', 'select * from app.redeem_invite($1::bytea, $2)', [HASH, invitee])
    expect(first.rows).toEqual([{ brand_id: A, role: 'approver' }])
    const member = await db.admin.query(
      'select role from app.membership where brand_id = $1 and user_id = $2',
      [A, invitee],
    )
    expect(member.rows).toEqual([{ role: 'approver' }])
    await expect(
      query(db, 'app', 'select * from app.redeem_invite($1::bytea, $2)', [HASH, invitee]),
    ).rejects.toMatchObject({
      code: 'MKT01',
    })
    const peek = await query(db, 'app', 'select * from app.peek_invite($1::bytea)', [HASH])
    expect(peek.rows).toEqual([])
  })

  it('refuses an expired invite', async () => {
    const hash = '\\x' + 'ef'.repeat(32)
    await db.admin.query(
      `insert into app.invite (brand_id, email, role, token_hash, expires_at, invited_by)
       values ($1, 'late@example.test', 'viewer', $2::bytea, now() - interval '1 second', $3)`,
      [A, hash, inviter],
    )
    expect((await query(db, 'app', 'select * from app.peek_invite($1::bytea)', [hash])).rows).toEqual([])
    await expect(
      query(db, 'app', 'select * from app.redeem_invite($1::bytea, $2)', [hash, invitee]),
    ).rejects.toMatchObject({
      code: 'MKT01',
    })
  })

  it('lets only the application role call them', async () => {
    for (const role of ['readonly', 'queue', 'audit_writer', 'owner_view'] as const) {
      await expect(
        query(db, role, 'select * from app.peek_invite($1::bytea)', [HASH]),
        role,
      ).rejects.toMatchObject({
        code: '42501',
      })
    }
  })
})
