import { requireDatabase } from '@mkt/test-support'
import { describe, expect, it } from 'vitest'
import { createPool } from '../src/pool.ts'
import { createTestDatabase } from '../src/testing.ts'

describe('createPool', () => {
  it('starts every connection with the given search path', async () => {
    await requireDatabase()
    const db = await createTestDatabase()
    const pool = createPool(db.urlFor('app'), { searchPath: 'auth' })
    try {
      const result = await pool.query('show search_path')
      expect(result.rows[0].search_path).toBe('auth')
    } finally {
      await pool.end()
      await db.drop()
    }
  })

  it('leaves the search path alone when none is given', async () => {
    await requireDatabase()
    const db = await createTestDatabase()
    const pool = createPool(db.urlFor('app'))
    try {
      const result = await pool.query('show search_path')
      expect(result.rows[0].search_path).not.toContain('auth')
    } finally {
      await pool.end()
      await db.drop()
    }
  })
})
