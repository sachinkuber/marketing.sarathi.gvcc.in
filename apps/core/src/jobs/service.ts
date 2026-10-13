import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import { CLASS_SETTINGS, type JobClass, type Queue } from '@mkt/queue'
import { randomUUID } from 'node:crypto'
import type { AuditSink } from '../ports.ts'
import { AppError } from '../errors.ts'
import type { ResultHandlers } from './results.ts'
import { signAttemptToken, type AttemptClaims } from './token.ts'

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

export interface StartedAttempt {
  finished: false
  attemptId: string
  attemptNumber: number
  token: string
  input: unknown
  savedSteps: unknown[]
  expectedResultType: string
  jobClass: JobClass
}
export interface FinishedJob {
  finished: true
  outcome: unknown
}

export async function startAttempt(
  deps: JobsDeps,
  jobId: string,
  workerId: string,
): Promise<StartedAttempt | FinishedJob> {
  const found = await deps.pool.query<{ brand: string | null }>('select app.job_brand($1) as brand', [jobId])
  const brandId = found.rows[0]?.brand
  if (!brandId) throw new AppError(404, 'job_not_found', 'No such job.')

  return withBrand(deps.pool, brandId, async (client) => {
    const job = await client.query<{
      class: JobClass
      input: unknown
      saved_steps: unknown[]
      expected_result_type: string
      outcome: unknown
      finished_at: Date | null
    }>(
      `select class, input, saved_steps, expected_result_type, outcome, finished_at
         from app.job_input where job_id = $1 for update`,
      [jobId],
    )
    const row = job.rows[0]
    if (!row) throw new AppError(404, 'job_not_found', 'No such job.')
    // A job already finished (the worker crashed after the core accepted the result): tell it so, and the
    // worker completes the queue row. No new attempt.
    if (row.finished_at) return { finished: true as const, outcome: row.outcome }

    // The queue's own record, not the worker's word: the job must be active.
    if ((await deps.queue.state(row.class, jobId)) !== 'active') {
      throw new AppError(409, 'job_not_active', 'The queue does not show this job as claimed.')
    }

    await client.query(
      `update app.job_attempt set state = 'superseded', ended_at = now() where job_id = $1 and state = 'active'`,
      [jobId],
    )
    const next = await client.query<{ n: number }>(
      'select coalesce(max(attempt_number), 0) + 1 as n from app.job_attempt where job_id = $1',
      [jobId],
    )
    const attemptNumber = Number(next.rows[0]!.n)
    const tokenId = randomUUID()
    const created = await client.query<{ id: string }>(
      `insert into app.job_attempt (brand_id, job_id, attempt_number, worker_id, token_id)
       values ($1, $2, $3, $4, $5) returning id`,
      [brandId, jobId, attemptNumber, workerId, tokenId],
    )
    const attemptId = created.rows[0]!.id
    // A requeued job is no longer dead.
    await client.query('update app.job_control set dead_at = null, updated_at = now() where job_id = $1', [
      jobId,
    ])

    const issuedAt = Math.floor(deps.now().getTime() / 1000)
    const claims: AttemptClaims = {
      tokenId,
      jobId,
      brandId,
      attemptId,
      resultType: row.expected_result_type,
      issuedAt,
      expiresAt: issuedAt + CLASS_SETTINGS[row.class].expireInSeconds,
    }
    return {
      finished: false as const,
      attemptId,
      attemptNumber,
      token: signAttemptToken(deps.attemptTokenSecret, claims),
      input: row.input,
      savedSteps: row.saved_steps,
      expectedResultType: row.expected_result_type,
      jobClass: row.class,
    }
  })
}

// The attempt in the token must be the job's current one: the latest, and still active (or already
// succeeded, so a repeated result post gets its first outcome back). Anything else is refused and recorded.
//
// Callers must call this first inside the transaction that then writes. It takes the job's row lock (the
// same lock startAttempt holds while it supersedes), so a supersede cannot commit between this check and
// the caller's write: it waits until the caller's transaction ends, and the old attempt is refused after.
export async function requireCurrentAttempt(
  client: PoolClient,
  deps: JobsDeps,
  claims: AttemptClaims,
): Promise<void> {
  await client.query('select 1 from app.job_input where job_id = $1 for update', [claims.jobId])
  const { rows } = await client.query<{ id: string; state: string }>(
    `select id, state from app.job_attempt where job_id = $1 order by attempt_number desc limit 1`,
    [claims.jobId],
  )
  const latest = rows[0]
  const current =
    latest?.id === claims.attemptId && (latest.state === 'active' || latest.state === 'succeeded')
  if (current) return
  const reason = latest?.id === claims.attemptId ? 'attempt_ended' : 'attempt_superseded'
  await deps.audit.record({
    action: 'worker.attempt_refused',
    actor: null,
    brandId: claims.brandId,
    subject: claims.jobId,
    outcome: 'failure',
    detail: { reason, jobId: claims.jobId, attemptId: claims.attemptId },
  })
  throw new AppError(403, 'attempt_refused', 'This attempt may not do that.')
}

export async function readControl(
  client: PoolClient,
  jobId: string,
): Promise<{ cancelRequested: boolean; held: boolean }> {
  const { rows } = await client.query<{ cancel_requested: boolean; held: boolean }>(
    'select cancel_requested, held from app.job_control where job_id = $1',
    [jobId],
  )
  const row = rows[0]
  return { cancelRequested: row?.cancel_requested ?? false, held: row?.held ?? false }
}
