import pg from 'pg'
import { PgBoss } from 'pg-boss'
import { CLASS_SETTINGS, JOB_CLASSES, perProcessCap, type JobClass } from './classes.ts'
import { executeSqlOn, QUEUE_SCHEMA } from './install.ts'

export type SqlClient = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }
// `id` is the job's own id (the data the row carries); `queueId` is the queue row's id. They are the same for
// a job's first send; a kill-switch release sends a held job again under a new queue id (the row the library
// completed while the job was held cannot be sent or retried again), and the core accepts only the newest.
export interface QueueJob {
  id: string
  queueId: string
  jobClass: JobClass
}
export type JobState = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed'

export interface Queue {
  // `queueId` defaults to the job id; a release passes a new one.
  send(
    client: SqlClient,
    input: { jobId: string; jobClass: JobClass; scheduleKey: string; queueId?: string },
  ): Promise<void>
  work(
    jobClass: JobClass,
    options: { processes: number },
    handler: (job: QueueJob) => Promise<void>,
  ): Promise<void>
  // By queue id (the job id unless a release sent the job again).
  state(jobClass: JobClass, queueId: string): Promise<JobState | null>
  depth(jobClass: JobClass): Promise<number>
  deadJobs(jobClass: JobClass): Promise<string[]>
  // The watcher for a class's dead-letter queue: the handler is given the job ID of each job the library has
  // given up on. Handling a copy completes it, so the queue stays empty: the business tables are the list.
  // Jobs the library has failed for good in a class's main queue, newest first, at most `limit` (so a new
  // failure is always inside the window): the reconciliation that
  // covers a dead-letter copy that never reached the core.
  // Job ids (from the row's data), not queue ids.
  failedJobIds(jobClass: JobClass, limit?: number): Promise<string[]>
  onDead(jobClass: JobClass, handler: (jobId: string) => Promise<void>): Promise<void>
  // The queue row is `queueId` (default: the job id); the dead-letter copies are found by job id.
  requeue(jobClass: JobClass, jobId: string, queueId?: string): Promise<void>
  cancel(jobClass: JobClass, jobId: string, queueId?: string): Promise<void>
  watchdog(
    now: Date,
    limits: { maxWaitSeconds: Record<JobClass, number> },
  ): Promise<{ waiting: string[]; running: string[] }>
  // Default: stop at once, abandoning running handlers (their jobs are recovered by the heartbeat). A worker
  // process asks for a graceful stop: no new job is taken and running handlers get `timeoutSeconds` to finish.
  stop(options?: { graceful?: boolean; timeoutSeconds?: number }): Promise<void>
}

export interface OpenOptions {
  // A worker process supervises (expiry, retry, archiving); the core's reading connection does not.
  supervise?: boolean
  // How often a supervising process looks for expired or heartbeat-less jobs. The library's default is
  // far longer than the crash tests can wait; tests (and the queue trial) use 1.
  superviseIntervalSeconds?: number
  // Called with every error the library or the reading pool emits (a lost connection, a failed supervise).
  // The default writes one JSON line to stderr; a process with its own log passes it here.
  onError?: (error: Error) => void
}

export function defaultOnError(error: Error): void {
  process.stderr.write(`${JSON.stringify({ event: 'queue_error', error: error.message })}\n`)
}

// Slots per process: always several, never one, so a brand at its limit cannot hold up another (spec 9.2).
const SLOTS_PER_CLASS = 6

export async function openQueue(queueUrl: string, options: OpenOptions = {}): Promise<Queue> {
  const onError = options.onError ?? defaultOnError
  const boss = new PgBoss({
    connectionString: queueUrl,
    schema: QUEUE_SCHEMA,
    migrate: false,
    createSchema: false,
    supervise: options.supervise ?? false,
    ...(options.superviseIntervalSeconds
      ? {
          superviseIntervalSeconds: options.superviseIntervalSeconds,
          monitorIntervalSeconds: options.superviseIntervalSeconds,
        }
      : {}),
    schedule: false,
    useListenNotify: true,
  })
  boss.on('error', onError)
  await boss.start()
  // Reads the library has no call for (depth, dead copies, the watchdog) go through the queue role directly.
  const reader = new pg.Pool({ connectionString: queueUrl, max: 2 })
  reader.on('error', onError)

  // A slot that finishes a job must look for the next one at once, and so must the slots that are idle.
  // Left alone, the library sleeps a slot for the polling interval after every job, and the slots of a
  // class, started together, then fetch together on the same tick. Each fetch skips only the brands
  // already at their limit when the tick began, so every slot claims the oldest backlog: one brand's
  // jobs fill the slots up to its limit, the rest are handed back, and another brand's jobs are never
  // claimed while that backlog lasts (spec 9.2). Waking the slots as each job ends (while its brand still
  // counts as running) lets the idle ones take the other brands' jobs, and the finishing one take the
  // next job of its own brand, so a brand stays at its limit and the others share the remaining slots.
  // This leans on library internals (pg-boss 12.30): a slot's notified flag is cleared only at the start of
  // its next fetch, and a job's brand count is decremented only after the job is completed, that is after
  // this wake. A pg-boss upgrade must re-run acceptance test 29 (packages/queue/test/fairness.test.ts).
  // A wake that throws is reported and never replaces the handler's result or fails a finished job.
  const wakeSlots = (queueName: string): void => {
    try {
      for (const slot of boss.getWipData()) {
        if (slot.name === queueName) boss.notifyWorker(slot.id)
      }
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  return {
    async send(client, { jobId, jobClass, scheduleKey, queueId = jobId }) {
      // A job is a job ID (in the data, so a dead-letter copy can be traced back), a class (the queue) and a
      // scheduling key (the group). Nothing else: no client content, no business input (spec 9.1).
      const id = await boss.send(
        CLASS_SETTINGS[jobClass].queue,
        { jobId },
        { id: queueId, group: { id: scheduleKey }, db: executeSqlOn(client) },
      )
      // The library answers null for a duplicate ID (or a missing queue) instead of throwing. A job row
      // without a queue row would never run, so the caller's transaction must roll back.
      if (!id) throw new Error(`The queue did not accept job ${jobId}.`)
    },

    async work(jobClass, { processes }, handler) {
      const s = CLASS_SETTINGS[jobClass]
      const cap = perProcessCap(s.brandCap, processes)
      await boss.work(
        s.queue,
        {
          localGroupConcurrency: cap,
          localConcurrency: SLOTS_PER_CLASS,
          // One job per fetch, set here rather than left to the library default: a handler's throw fails only
          // its own job.
          batchSize: 1,
          pollingIntervalSeconds: s.pollingIntervalSeconds,
          // Notification wakes a worker for a new job, but nothing notifies when a retry's delay ends, so the
          // backstop poll stays at the class's own interval; a slower one would add up to 30s to every retry.
          notifyPollingIntervalSeconds: s.pollingIntervalSeconds,
        },
        async ([job]) => {
          try {
            if (job) {
              const jobId = (job.data as { jobId?: string } | null)?.jobId ?? job.id
              await handler({ id: jobId, queueId: job.id, jobClass })
            }
          } finally {
            wakeSlots(s.queue)
          }
        },
      )
    },

    async state(jobClass, queueId) {
      const job = await boss.getJobById(CLASS_SETTINGS[jobClass].queue, queueId)
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

    async requeue(jobClass, jobId, queueId = jobId) {
      const s = CLASS_SETTINGS[jobClass]
      // pg-boss 12.30: retry keeps retry_count and raises retry_limit by one, so a requeued job gets exactly
      // one more try before it is dead again (packages/queue/test/queue-dead.test.ts).
      await boss.retry(s.queue, queueId)
      // The dead-letter copy has done its job: take it off the list.
      const { rows } = await reader.query<{ id: string }>(
        `select id from ${QUEUE_SCHEMA}.job where name = $1 and data->>'jobId' = $2 and state = 'created'`,
        [s.deadLetter, jobId],
      )
      for (const r of rows) await boss.cancel(s.deadLetter, r.id)
    },

    async failedJobIds(jobClass, limit = 500) {
      const { rows } = await reader.query<{ id: string }>(
        `select coalesce(data->>'jobId', id::text) as id from ${QUEUE_SCHEMA}.job
          where name = $1 and state = 'failed' order by completed_on desc limit $2`,
        [CLASS_SETTINGS[jobClass].queue, limit],
      )
      return rows.map((r) => r.id)
    },

    async onDead(jobClass, handler) {
      const s = CLASS_SETTINGS[jobClass]
      await boss.work(s.deadLetter, { pollingIntervalSeconds: s.pollingIntervalSeconds }, async (batch) => {
        for (const copy of batch) {
          const jobId = (copy.data as { jobId?: string }).jobId
          if (jobId) await handler(jobId)
        }
      })
    },

    async cancel(jobClass, jobId, queueId = jobId) {
      const s = CLASS_SETTINGS[jobClass]
      await boss.cancel(s.queue, queueId)
      // The library cancels only jobs that have not finished. A dead job is "failed", which it leaves alone,
      // so a cancel of a dead job ends it here (a failed job is never picked up again, but "cancelled" is
      // what it is). Only a failed job is touched.
      await reader.query(
        `update ${QUEUE_SCHEMA}.job set state = 'cancelled', completed_on = now()
          where name = $1 and id = $2 and state = 'failed'`,
        [s.queue, queueId],
      )
      // Its dead-letter copy, if the watcher has not completed it yet, has nothing left to report.
      const { rows } = await reader.query<{ id: string }>(
        `select id from ${QUEUE_SCHEMA}.job where name = $1 and data->>'jobId' = $2 and state = 'created'`,
        [s.deadLetter, jobId],
      )
      for (const r of rows) await boss.cancel(s.deadLetter, r.id)
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
            where name = $1
              and ((state in ('created', 'retry') and greatest(created_on, start_after) < $2)
                or (state = 'active' and started_on < $3))`,
          [s.queue, waitLimit, runLimit],
        )
        for (const r of rows) (r.state === 'active' ? running : waiting).push(r.id)
      }
      return { waiting, running }
    },

    async stop(options = {}) {
      try {
        await boss.stop(
          options.graceful
            ? { graceful: true, timeout: Math.max(1, options.timeoutSeconds ?? 30) * 1000 }
            : { graceful: false },
        )
      } finally {
        await reader.end()
      }
    },
  }
}
