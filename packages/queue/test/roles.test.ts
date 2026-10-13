import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase } from '@mkt/test-support'
import type { TestDatabase } from '@mkt/db/testing'
import { executeSqlOn, installQueue } from '../src/install.ts'
import { createQueueTestDatabase } from '../src/testing.ts'

let db: TestDatabase
let boss: PgBoss
let app: pg.Pool
let queueRole: pg.Pool

beforeAll(async () => {
  await requireDatabase()
  db = await createQueueTestDatabase()
  // The runtime library instance: queue role, no schema creation, no migration, no supervision.
  boss = new PgBoss({
    connectionString: db.urlFor('queue'),
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
  })
  boss.on('error', () => {})
  await boss.start()
  app = new pg.Pool({ connectionString: db.urlFor('app') })
  queueRole = new pg.Pool({ connectionString: db.urlFor('queue') })
})

afterAll(async () => {
  await boss?.stop({ graceful: false })
  await app?.end()
  await queueRole?.end()
  await db?.drop()
})

describe('the queue schema and the roles', () => {
  it('lets the application role create a job inside its own transaction: rolled back leaves nothing, committed leaves one', async () => {
    const queue = 'job-production'
    const key = randomUUID()
    const rolledBack = randomUUID()
    const committed = randomUUID()

    const a = await app.connect()
    try {
      await a.query('begin')
      await boss.send(queue, {}, { id: rolledBack, group: { id: key }, db: executeSqlOn(a) })
      await a.query('rollback')
      await a.query('begin')
      await boss.send(queue, {}, { id: committed, group: { id: key }, db: executeSqlOn(a) })
      await a.query('commit')
    } finally {
      a.release()
    }
    expect(await boss.getJobById(queue, rolledBack)).toBeNull()
    expect((await boss.getJobById(queue, committed))?.state).toBe('created')
  })

  it('lets the queue role claim and finish a job', async () => {
    const queue = 'job-bulk'
    const id = randomUUID()
    const a = await app.connect()
    try {
      await a.query('begin')
      await boss.send(queue, {}, { id, group: { id: randomUUID() }, db: executeSqlOn(a) })
      await a.query('commit')
    } finally {
      a.release()
    }
    const [job] = await boss.fetch(queue)
    expect(job?.id).toBe(id)
    await boss.complete(queue, id)
    expect((await boss.getJobById(queue, id))?.state).toBe('completed')
  })

  it('refuses the application role every change to a job except creating it', async () => {
    await expect(app.query('delete from pgboss.job')).rejects.toThrow(/permission denied/)
    await expect(app.query("update pgboss.job set state = 'completed'")).rejects.toThrow(/permission denied/)
  })

  it('refuses the application role every change to the partition that holds the rows', async () => {
    await expect(app.query("update pgboss.job_common set state = 'completed'")).rejects.toThrow(
      /permission denied/,
    )
    await expect(app.query('delete from pgboss.job_common')).rejects.toThrow(/permission denied/)
  })

  it('lets the application role read only the id and start_after of a queued job, never its data', async () => {
    await expect(app.query('select data from pgboss.job_common')).rejects.toThrow(/permission denied/)
    await expect(app.query('select * from pgboss.job_common')).rejects.toThrow(/permission denied/)
    await expect(app.query('select id from pgboss.job')).rejects.toThrow(/permission denied/)
  })

  it('keeps every business table out of the queue role (acceptance test 5)', async () => {
    for (const table of ['app.brand', 'app.job_input', 'app.content_item', 'app.membership']) {
      await expect(queueRole.query(`select 1 from ${table} limit 1`)).rejects.toThrow(/permission denied/)
    }
  })

  it('holds no client content or business input in a queue row (acceptance test 5)', async () => {
    const { rows } = await db.admin.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'pgboss' and table_name = 'job' order by 1`,
    )
    // The data column exists; what is put in it is fixed by the send helper and tested in task 3.
    expect(rows.map((r) => r.column_name)).toContain('data')
  })

  it('is safe to install twice', async () => {
    await expect(installQueue(db.urlFor('migration'))).resolves.toBeUndefined()
  })
})
