import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { databaseUrl, requireDatabase } from '../src/index.ts'

describe('development database', () => {
  it('is PostgreSQL 17.11', async () => {
    await requireDatabase()
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      const result = await client.query("select current_setting('server_version') as version")
      expect(result.rows[0].version).toMatch(/^17\.11\b/)
    } finally {
      await client.end()
    }
  })

  it('says how to start the database when it is not reachable', async () => {
    await expect(requireDatabase('postgres://mkt:mkt_dev_only@127.0.0.1:1/mkt_dev')).rejects.toThrow(
      'The development database is not reachable. Start it with: npm run db:up',
    )
  })
})
