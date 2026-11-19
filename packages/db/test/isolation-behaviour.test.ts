import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appRoleCannotDisableSecurity,
  brandTableShowsOnlyOwn,
  refusesCrossBrandParent,
  refusesInsertForOtherBrand,
  refusesInsertWithoutBrand,
  refusesUpdateToOtherBrand,
  SEEDED,
  seesNothingWithoutBrand,
  seesOwnBrandRows,
  serviceRolesReadNoBusinessTable,
  type AsRole,
} from '../src/isolation-probes.ts'
import { createTestDatabase, RUNTIME_ROLES, seedBrand, type TestDatabase } from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

// The probes are shared with the restore drill (apps/ops/src/restore-check.ts). Here each runs as the role
// itself, logged in with its own password, in a transaction that is rolled back.
function asRoleOf(db: TestDatabase): AsRole {
  return async (role, brand, fn) => {
    const client = new pg.Client({ connectionString: db.urlFor(role) })
    await client.connect()
    try {
      await client.query('begin')
      if (brand) await client.query("select set_config('app.brand_id', $1, true)", [brand])
      return await fn(client)
    } finally {
      await client.query('rollback').catch(() => undefined)
      await client.end()
    }
  }
}

describe('tenant isolation in the database (acceptance tests 2, 3 and 5)', () => {
  let db: TestDatabase
  let as: AsRole
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    as = asRoleOf(db)
    await seedBrand(db, A, 'brand-a')
    await seedBrand(db, B, 'brand-b')
  })
  afterAll(async () => db.drop())

  for (const table of SEEDED) {
    it(`the application role sees only its own brand's rows in ${table}`, async () => {
      await seesOwnBrandRows(as, 'app', A, table)
    })

    it(`the read-only role sees only its own brand's rows in ${table}`, async () => {
      await seesOwnBrandRows(as, 'readonly', B, table)
    })

    it(`with no brand set, the application and read-only roles see no rows in ${table}`, async () => {
      await seesNothingWithoutBrand(as, table)
    })
  }

  it('the brand table shows a session only its own brand', async () => {
    await brandTableShowsOnlyOwn(as, A)
  })

  it('the queue, audit-writer and owner-view roles cannot read any business table', async () => {
    await serviceRolesReadNoBusinessTable(as, A)
  })

  it('covers every run-time role', () => {
    expect([...RUNTIME_ROLES].sort()).toEqual(['app', 'audit_writer', 'owner_view', 'queue', 'readonly'])
  })

  it('refuses an insert that carries another brand', async () => {
    await refusesInsertForOtherBrand(as, A, B)
  })

  it('refuses an update that moves a row to another brand', async () => {
    await refusesUpdateToOtherBrand(as, A, B)
  })

  it('refuses any insert when no brand is set', async () => {
    await refusesInsertWithoutBrand(as, A)
  })

  it('refuses a row in brand A pointing at a parent row in brand B', async () => {
    await refusesCrossBrandParent(as, A, B)
  })

  it('cannot be bypassed by the application role altering a table', async () => {
    await appRoleCannotDisableSecurity(as, A)
  })
})
