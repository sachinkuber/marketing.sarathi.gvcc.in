import { createPool, type Pool } from '@mkt/db'
import { createTestDatabase, type TestDatabase } from '@mkt/db/testing'
import { requireDatabase } from '@mkt/test-support'
import { getMigrations } from 'better-auth/db/migration'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AttemptLimiter } from '../src/auth/limiter.ts'
import { authOptions } from '../src/auth/options.ts'
import { MemoryAudit, MemoryMailer } from '../src/testing.ts'

describe('the committed auth migration matches what the pinned library expects', () => {
  let db: TestDatabase
  let pool: Pool
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    pool = createPool(db.urlFor('app'), { searchPath: 'auth' })
  })
  afterAll(async () => {
    await pool.end()
    await db.drop()
  })

  it('has nothing left to create or add, so a library upgrade that needs a change is noticed', async () => {
    const plan = await getMigrations(
      authOptions({
        pool,
        secret: 's'.repeat(40),
        baseURL: 'https://app.example.test',
        mailer: new MemoryMailer(),
        audit: new MemoryAudit(),
        limiter: new AttemptLimiter({ maxFailures: 5, windowMs: 1, lockMs: 1 }),
      }),
    )
    expect(plan.toBeCreated).toEqual([])
    expect(plan.toBeAdded).toEqual([])
    expect(plan.toBeAddedIndexes).toEqual([])
  })
})
