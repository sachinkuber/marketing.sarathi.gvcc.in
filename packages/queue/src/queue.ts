import pg from 'pg'
import { PgBoss } from 'pg-boss'
import { CLASS_SETTINGS, JOB_CLASSES, perProcessCap, type JobClass } from './classes.ts'
import { executeSqlOn, QUEUE_SCHEMA } from './install.ts'

export type SqlClient = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }
export interface QueueJob {
  id: string
  jobClass: JobClass
}
export type JobState = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed'

export interface Queue {
  send(client: SqlClient, input: { jobId: string; jobClass: JobClass; scheduleKey: string }): Promise<void>
  work(
    jobClass: JobClass,
    options: { processes: number },
    handler: (job: QueueJob) => Promise<void>,
  ): Promise<void>
  state(jobClass: JobClass, jobId: string): Promise<JobState | null>
  depth(jobClass: JobClass): Promise<number>
  deadJobs(jobClass: JobClass): Promise<string[]>
  requeue(jobClass: JobClass, jobId: string): Promise<void>
  cancel(jobClass: JobClass, jobId: string): Promise<void>
  watchdog(
    now: Date,
    limits: { maxWaitSeconds: Record<JobClass, number> },
  ): Promise<{ waiting: string[]; running: string[] }>
  stop(): Promise<void>
}

export interface OpenOptions {
  // A worker process supervises (expiry, retry, archiving); the core's reading connection does not.
  supervise?: boolean
}

// Slots per process: always several, never one, so a brand at its limit cannot hold up another (spec 9.2).
const SLOTS_PER_CLASS = 6

export async function openQueue(queueUrl: string, options: OpenOptions = {}): Promise<Queue> {
  const boss = new PgBoss({
    connectionString: queueUrl,
    schema: QUEUE_SCHEMA,
    migrate: false,
    createSchema: false,
    supervise: options.supervise ?? false,
    schedule: false,
    useListenNotify: true,
  })
  boss.on('error', () => {})
  await boss.start()
  // Reads the library has no call for (depth, dead copies, the watchdog) go through the queue role directly.
  const reader = new pg.Pool({ connectionString: queueUrl, max: 2 })
  reader.on('error', () => {})

  return {
    async send(client, { jobId, jobClass, scheduleKey }) {
      // A job is a job ID (in the data, so a dead-letter copy can be traced back), a class (the queue) and a
      // scheduling key (the group). Nothing else: no client content, no business input (spec 9.1).
      await boss.send(
        CLASS_SETTINGS[jobClass].queue,
        { jobId },
        { id: jobId, group: { id: scheduleKey }, db: executeSqlOn(client) },
      )
    },

    async work(jobClass, { processes }, handler) {
      const s = CLASS_SETTINGS[jobClass]
      const cap = perProcessCap(s.brandCap, processes)
      await boss.work(
        s.queue,
        {
          localGroupConcurrency: cap,
          localConcurrency: SLOTS_PER_CLASS,
          pollingIntervalSeconds: s.pollingIntervalSeconds,
          // Notification wakes a worker for a new job, but nothing notifies when a retry's delay ends, so the
          // backstop poll stays at the class's own interval; a slower one would add up to 30s to every retry.
          notifyPollingIntervalSeconds: s.pollingIntervalSeconds,
        },
        async (batch) => {
          // One job at a time per slot: a handler's throw fails only its own job.
          for (const job of batch) await handler({ id: job.id, jobClass })
        },
      )
    },

    async state(jobClass, jobId) {
      const job = await boss.getJobById(CLASS_SETTINGS[jobClass].queue, jobId)
      return (job?.state as JobState | undefined) ?? null
    },

    async depth(jobClass) {
      const { rows } = await reader.query<{ n: string }>(
        `select count(*) as n from ${QUEUE_SCHEMA}.job where name = $1 and state in ('created', 'retry')`,
        [CLASS_SETTINGS[jobClass].queue],
      )
      return Number(rows[0]?.n ?? 0)
    },

    async deadJobs(jobClass) {
      const { rows } = await reader.query<{ id: string }>(
        `select data->>'jobId' as id from ${QUEUE_SCHEMA}.job where name = $1 and state in ('created', 'retry')`,
        [CLASS_SETTINGS[jobClass].deadLetter],
      )
      return rows.map((r) => r.id)
    },

    async requeue(jobClass, jobId) {
      const s = CLASS_SETTINGS[jobClass]
      await boss.retry(s.queue, jobId)
      // The dead-letter copy has done its job: take it off the list.
      const { rows } = await reader.query<{ id: string }>(
        `select id from ${QUEUE_SCHEMA}.job where name = $1 and data->>'jobId' = $2 and state = 'created'`,
        [s.deadLetter, jobId],
      )
      for (const r of rows) await boss.cancel(s.deadLetter, r.id)
    },

    async cancel(jobClass, jobId) {
      await boss.cancel(CLASS_SETTINGS[jobClass].queue, jobId)
    },

    async watchdog(now, limits) {
      const waiting: string[] = []
      const running: string[] = []
      for (const jobClass of JOB_CLASSES) {
        const s = CLASS_SETTINGS[jobClass]
        const waitLimit = new Date(now.getTime() - limits.maxWaitSeconds[jobClass] * 1000)
        const runLimit = new Date(now.getTime() - s.expireInSeconds * 1000)
        const { rows } = await reader.query<{ id: string; state: string }>(
          `select id, state from ${QUEUE_SCHEMA}.job
            where name = $1 and ((state = 'created' and created_on < $2) or (state = 'active' and started_on < $3))`,
          [s.queue, waitLimit, runLimit],
        )
        for (const r of rows) (r.state === 'created' ? waiting : running).push(r.id)
      }
      return { waiting, running }
    },

    async stop() {
      await reader.end()
      await boss.stop({ graceful: false })
    },
  }
}
