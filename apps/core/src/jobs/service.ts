import type { Pool, PoolClient } from '@mkt/db'
import type { JobClass, Queue } from '@mkt/queue'
import { randomUUID } from 'node:crypto'
import type { AuditSink } from '../ports.ts'
import { AppError } from '../errors.ts'
import type { ResultHandlers } from './results.ts'

export interface JobsDeps {
  pool: Pool
  queue: Queue
  audit: AuditSink
  workerSecret: string
  attemptTokenSecret: string
  backlogLimit: number
  now: () => Date
  results: ResultHandlers
}

export interface NewRun {
  agent: string
  definitionVersionId: string
  startedByKind: 'user' | 'agent' | 'system' | 'n8n'
  startedById: string | null
}

export async function createRun(client: PoolClient, brandId: string, run: NewRun): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into app.run (brand_id, agent, definition_version_id, state, started_by_kind, started_by_id)
     values ($1, $2, $3, 'running', $4, $5) returning id`,
    [brandId, run.agent, run.definitionVersionId, run.startedByKind, run.startedById],
  )
  return rows[0]!.id
}

export interface NewJob {
  runId: string
  jobClass: JobClass
  input: unknown
  expectedResultType: string
}

// Backpressure applies to production and bulk work only (architecture 7.1): interactive and publishing
// work is never refused for a backlog.
const BACKPRESSURE: ReadonlySet<JobClass> = new Set(['production', 'bulk'])

// Runs inside the caller's withBrand transaction, so the job exists if and only if the business change does.
export async function createJob(
  client: PoolClient,
  deps: Pick<JobsDeps, 'queue' | 'backlogLimit'>,
  brandId: string,
  job: NewJob,
): Promise<string> {
  if (BACKPRESSURE.has(job.jobClass) && (await deps.queue.depth(job.jobClass)) >= deps.backlogLimit) {
    throw new AppError(503, 'queue_busy', 'Too much work is waiting. Try again shortly.')
  }
  const brand = await client.query<{ schedule_key: string }>(
    'select schedule_key from app.brand where id = $1',
    [brandId],
  )
  const scheduleKey = brand.rows[0]?.schedule_key
  if (!scheduleKey) throw new AppError(404, 'brand_not_found', 'No such brand.')
  const jobId = randomUUID()
  await client.query(
    `insert into app.job_input (job_id, brand_id, run_id, class, input, expected_result_type)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [jobId, brandId, job.runId, job.jobClass, JSON.stringify(job.input), job.expectedResultType],
  )
  await client.query('insert into app.job_control (job_id, brand_id) values ($1, $2)', [jobId, brandId])
  await deps.queue.send(client, { jobId, jobClass: job.jobClass, scheduleKey })
  return jobId
}
