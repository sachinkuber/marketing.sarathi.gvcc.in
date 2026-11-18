import { requireDatabase } from '@mkt/test-support'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  brandIdInForeignKeys,
  brandIdUniqueKeys,
  brandPolicies,
  brandScopedTables,
  noPublicFunctions,
  rowSecurityForced,
  scopedTablesFound,
} from '../src/isolation-probes.ts'
import { createTestDatabase, type TestDatabase } from '../src/testing.ts'

// The probes are shared with the restore drill (apps/ops/src/restore-check.ts), which runs them on a restored copy.
describe('every brand-scoped table follows the rules (acceptance tests 3 and 4)', () => {
  let db: TestDatabase
  let scoped: string[]
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    scoped = await brandScopedTables(db.admin)
  })
  afterAll(async () => db.drop())

  it('leaves no function in the app or audit schema executable by PUBLIC, except triggers', async () => {
    await noPublicFunctions(db.admin)
  })

  it('finds the brand-scoped tables, so the tests below cannot pass on an empty list', () => {
    scopedTablesFound(scoped)
  })

  it('has row-level security enabled and forced on each', async () => {
    await rowSecurityForced(db.admin, scoped)
  })

  it('has one policy brand_isolation per table with the same read and write condition', async () => {
    await brandPolicies(db.admin, scoped)
  })

  it('has a unique key on (brand_id, id) wherever a table has an id', async () => {
    await brandIdUniqueKeys(db.admin, scoped)
  })

  it('has brand_id in every foreign key between brand-scoped tables, on both sides', async () => {
    await brandIdInForeignKeys(db.admin, scoped)
  })
})
