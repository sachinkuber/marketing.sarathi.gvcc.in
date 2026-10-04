import { databaseUrl, requireDatabase } from '@mkt/test-support'
import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import { fromKysely, type PgBoss } from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startQueue, uniqueName } from './support.ts'

describe('a job is created in the same transaction as a business change', () => {
  let queue: PgBoss
  let db: Kysely<Record<string, never>>
  const table = uniqueName('contract_biz')
  const name = uniqueName('tx')

  beforeAll(async () => {
    await requireDatabase()
    db = new Kysely({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }),
    })
    await sql`create table ${sql.id(table)} (id int primary key)`.execute(db)
    queue = await startQueue()
    await queue.createQueue(name)
  })

  afterAll(async () => {
    await queue.stop({ graceful: false })
    await sql`drop table if exists ${sql.id(table)}`.execute(db)
    await db.destroy()
  })

  it('creates no job and no row when the transaction rolls back', async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`insert into ${sql.id(table)} (id) values (1)`.execute(trx)
        await queue.send(name, { n: 1 }, { db: fromKysely(trx) })
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')

    expect(await queue.fetch(name)).toHaveLength(0)
    const rows = await sql<{ count: string }>`select count(*) as count from ${sql.id(table)}`.execute(db)
    expect(rows.rows[0]?.count).toBe('0')
  })

  it('creates the job and the row together when the transaction commits', async () => {
    await db.transaction().execute(async (trx) => {
      await sql`insert into ${sql.id(table)} (id) values (2)`.execute(trx)
      await queue.send(name, { n: 2 }, { db: fromKysely(trx) })
    })

    const jobs = await queue.fetch<{ n: number }>(name)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.data).toEqual({ n: 2 })
  })
})
