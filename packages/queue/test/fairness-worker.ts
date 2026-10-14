// Run as a separate process by fairness.test.ts. Claims production and interactive jobs, records
// each claim and release with the brand's scheduling key, then waits to be killed.
import { appendFile } from 'node:fs/promises'
import pg from 'pg'
import { openQueue } from '../src/queue.ts'

const [queueUrl, adminUrl, logFile, processes] = process.argv.slice(2) as [string, string, string, string]
// Reads the scheduling key as the database owner: the application role has no select on the queue's tables.
const admin = new pg.Pool({ connectionString: adminUrl })
const queue = await openQueue(queueUrl, { supervise: true })
const n = Number(processes)

async function keyOf(id: string): Promise<string> {
  const { rows } = await admin.query<{ key: string }>(
    `select group_id as key from pgboss.job where id = $1`,
    [id],
  )
  return rows[0]?.key ?? ''
}

for (const jobClass of ['production', 'interactive'] as const) {
  await queue.work(jobClass, { processes: n }, async (job) => {
    const key = await keyOf(job.id)
    await appendFile(logFile, `${Date.now()} start ${jobClass} ${key} ${job.id}\n`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    await appendFile(logFile, `${Date.now()} end ${jobClass} ${key} ${job.id}\n`)
  })
}
process.send?.('ready')
