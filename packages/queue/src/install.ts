import pg from 'pg'
import { PgBoss } from 'pg-boss'
import { CLASS_SETTINGS, JOB_CLASSES, type JobClass } from './classes.ts'

export const QUEUE_SCHEMA = 'pgboss'

function defaultInstallOnError(error: Error): void {
  process.stderr.write(`${JSON.stringify({ event: 'queue_error', error: error.message })}\n`)
}

export const DEAD_LETTER_RETRY_LIMIT = 10
export const DEAD_LETTER_RETRY_DELAY_SECONDS = 30

// pg-boss takes an object with executeSql to run a send on the caller's own connection, which is how a
// job joins the caller's transaction (trial result 1).
export function executeSqlOn(client: {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}) {
  return {
    executeSql: async (text: string, values?: unknown[]) => {
      const result = await client.query(text, values)
      return { rows: result.rows }
    },
  }
}

// What each run-time role may do in the queue schema (database schema 11.1):
// the queue role claims and updates jobs; the application role may only create them.
const GRANTS = `
grant usage on schema ${QUEUE_SCHEMA} to mkt_queue, mkt_app;
grant select, insert, update, delete on all tables in schema ${QUEUE_SCHEMA} to mkt_queue;
grant usage, select on all sequences in schema ${QUEUE_SCHEMA} to mkt_queue;
grant execute on all functions in schema ${QUEUE_SCHEMA} to mkt_queue;
grant insert on ${QUEUE_SCHEMA}.job to mkt_app;
-- send inserts into the shared job_common partition by name, not through job, and reads back the id
-- (and start_after, for a notify queue) with RETURNING, which needs select on those two columns only.
grant insert on ${QUEUE_SCHEMA}.job_common to mkt_app;
grant select (id, start_after) on ${QUEUE_SCHEMA}.job_common to mkt_app;
grant select on ${QUEUE_SCHEMA}.queue to mkt_app;
`

// testScale shortens the timings of the queues for a test database only; production installs at 1.
interface InstallOptions {
  testScale?: number
  onError?: (error: Error) => void
}

// A dead-letter copy is handled by the worker telling the core. If the core is down, the copy must be
// retried for hours, not the library's few default seconds: backed-off retries sized for an outage.
function deadLetterSettings(scale: number) {
  return {
    retryLimit: DEAD_LETTER_RETRY_LIMIT,
    retryDelay: Math.max(1, Math.ceil(DEAD_LETTER_RETRY_DELAY_SECONDS * scale)),
    retryBackoff: true,
  }
}

// The settings a queue's update may change. The library fixes heartbeatSeconds when the queue is created.
function queueSettings(jobClass: JobClass, scale: number) {
  const s = CLASS_SETTINGS[jobClass]
  return {
    deadLetter: s.deadLetter,
    expireInSeconds: Math.max(30, Math.ceil(s.expireInSeconds * scale)),
    retryLimit: s.retryLimit,
    retryDelay: Math.max(1, Math.ceil(s.retryDelaySeconds * scale)),
    retryBackoff: true,
    notify: s.notify,
  }
}

async function withBoss(adminUrl: string, options: InstallOptions, fn: (boss: PgBoss) => Promise<void>) {
  const boss = new PgBoss({ connectionString: adminUrl, schema: QUEUE_SCHEMA })
  boss.on('error', options.onError ?? defaultInstallOnError)
  await boss.start()
  try {
    await fn(boss)
  } finally {
    await boss.stop({ graceful: false })
  }
}

// Run at deployment, and by the test harness, as the role that owns the database (never at run time).
export async function installQueue(adminUrl: string, options: InstallOptions = {}): Promise<void> {
  const scale = options.testScale ?? 1
  await withBoss(adminUrl, options, async (boss) => {
    for (const jobClass of JOB_CLASSES) {
      const s = CLASS_SETTINGS[jobClass]
      // The dead-letter queue must exist before the queue that points at it.
      if (!(await boss.getQueue(s.deadLetter))) {
        await boss.createQueue(s.deadLetter, deadLetterSettings(scale))
      }
      if (!(await boss.getQueue(s.queue))) {
        await boss.createQueue(s.queue, {
          ...queueSettings(jobClass, scale),
          heartbeatSeconds: Math.max(10, Math.ceil(s.heartbeatSeconds * scale)),
        })
      }
    }
  })
  const pool = new pg.Pool({ connectionString: adminUrl })
  try {
    await pool.query(GRANTS)
  } finally {
    await pool.end()
  }
}

// installQueue creates only the queues that are missing, so on a deployment whose queues exist this brings
// their settings to the ones above (the deploy order: migrations, installQueue, updateQueue). Every queue
// must already exist: run installQueue first.
export async function updateQueue(adminUrl: string, options: InstallOptions = {}): Promise<void> {
  const scale = options.testScale ?? 1
  await withBoss(adminUrl, options, async (boss) => {
    for (const jobClass of JOB_CLASSES) {
      const s = CLASS_SETTINGS[jobClass]
      for (const name of [s.deadLetter, s.queue]) {
        if (!(await boss.getQueue(name)))
          throw new Error(`Queue ${name} does not exist: run installQueue first.`)
      }
      await boss.updateQueue(s.deadLetter, deadLetterSettings(scale))
      await boss.updateQueue(s.queue, queueSettings(jobClass, scale))
    }
  })
}
