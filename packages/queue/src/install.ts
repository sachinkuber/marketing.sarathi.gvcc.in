import pg from 'pg'
import { PgBoss } from 'pg-boss'
import { CLASS_SETTINGS, JOB_CLASSES } from './classes.ts'

export const QUEUE_SCHEMA = 'pgboss'

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

// Run at deployment, and by the test harness, as the role that owns the database (never at run time).
// testScale shortens the timings of the queues for a test database only; production installs at 1.
export async function installQueue(adminUrl: string, options: { testScale?: number } = {}): Promise<void> {
  const scale = options.testScale ?? 1
  const boss = new PgBoss({ connectionString: adminUrl, schema: QUEUE_SCHEMA })
  boss.on('error', () => {})
  await boss.start()
  try {
    for (const jobClass of JOB_CLASSES) {
      const s = CLASS_SETTINGS[jobClass]
      // The dead-letter queue must exist before the queue that points at it.
      if (!(await boss.getQueue(s.deadLetter))) await boss.createQueue(s.deadLetter)
      if (!(await boss.getQueue(s.queue))) {
        await boss.createQueue(s.queue, {
          deadLetter: s.deadLetter,
          heartbeatSeconds: Math.max(10, Math.ceil(s.heartbeatSeconds * scale)),
          expireInSeconds: Math.max(30, Math.ceil(s.expireInSeconds * scale)),
          retryLimit: s.retryLimit,
          retryDelay: Math.max(1, Math.ceil(s.retryDelaySeconds * scale)),
          retryBackoff: true,
          notify: s.notify,
        })
      }
    }
  } finally {
    await boss.stop({ graceful: false })
  }
  const pool = new pg.Pool({ connectionString: adminUrl })
  try {
    await pool.query(GRANTS)
  } finally {
    await pool.end()
  }
}
