import { createPool, withBrand, type Pool } from '@mkt/db'
import { createTestDatabase, seedBrand, type TestDatabase } from '@mkt/db/testing'
import { requireDatabase } from '@mkt/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DbAudit } from '../src/audit/db-audit.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const USER = '00000000-0000-4000-8000-0000000000d1'

describe('the database audit sink', () => {
  let db: TestDatabase
  let appPool: Pool
  let auditPool: Pool
  let audit: DbAudit
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    await seedBrand(db, A, 'brand-a')
    appPool = createPool(db.urlFor('app'))
    auditPool = createPool(db.urlFor('audit_writer'))
    audit = new DbAudit(auditPool)
  })
  afterAll(async () => {
    await appPool?.end()
    await auditPool?.end()
    await db?.drop()
  })

  const rows = async (chain: string) =>
    (await db.admin.query('select * from audit.log where chain_key = $1 order by seq', [chain])).rows

  it('writes a standalone entry for a person on the brand chain, and for nobody on the platform chain', async () => {
    await audit.record({
      action: 'auth.sign_in',
      actor: USER,
      brandId: A,
      outcome: 'success',
      detail: { emailHash: 'abc' },
    })
    await audit.record({
      action: 'auth.sign_in',
      actor: null,
      outcome: 'failure',
      detail: { emailHash: 'def' },
    })
    const brand = await rows(A)
    expect(brand).toHaveLength(1)
    expect(brand[0]).toMatchObject({
      actor_kind: 'user',
      actor_id: USER,
      action: 'auth.sign_in',
      outcome: 'success',
      detail: { emailHash: 'abc' },
    })
    const platform = await rows('platform')
    expect(platform).toHaveLength(1)
    expect(platform[0]).toMatchObject({
      actor_kind: 'system',
      actor_id: null,
      outcome: 'failure',
      brand_id: null,
    })
  })

  it('writes inside the transaction it is given, so a rollback takes the entry with it', async () => {
    const before = (await rows(A)).length
    await expect(
      withBrand(appPool, A, async (client) => {
        await audit.record(
          {
            action: 'users.role_changed',
            actor: USER,
            subject: USER,
            brandId: A,
            outcome: 'success',
            detail: { from: 'viewer', to: 'approver' },
          },
          client,
        )
        throw new Error('the change failed after the entry was written')
      }),
    ).rejects.toThrow('the change failed')
    expect(await rows(A)).toHaveLength(before)
    await withBrand(appPool, A, (client) =>
      audit.record(
        { action: 'users.role_changed', actor: USER, subject: USER, brandId: A, outcome: 'success' },
        client,
      ),
    )
    const after = await rows(A)
    expect(after).toHaveLength(before + 1)
    expect(after.at(-1)).toMatchObject({ subject: USER, detail: null })
  })

  it('refuses an entry for a brand the transaction is not working in', async () => {
    await expect(
      withBrand(appPool, A, (client) =>
        audit.record(
          {
            action: 'users.role_changed',
            actor: USER,
            brandId: '00000000-0000-4000-8000-00000000000b',
            outcome: 'success',
          },
          client,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})
