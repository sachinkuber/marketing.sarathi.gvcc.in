import { withBrand, type PoolClient } from '@mkt/db'
import { CLASS_SETTINGS, JOB_CLASSES, type JobClass } from '@mkt/queue'
import { AppError } from '../errors.ts'
import type { JobsDeps } from './service.ts'

export interface DeadJob {
  jobId: string
  runId: string
  jobClass: JobClass
  deadAt: string
  attempts: number
}

async function brandOf(deps: JobsDeps, jobId: string): Promise<string> {
  const { rows } = await deps.pool.query<{ brand: string | null }>('select app.job_brand($1) as brand', [
    jobId,
  ])
  const brand = rows[0]?.brand
  if (!brand) throw new AppError(404, 'job_not_found', 'No such job.')
  return brand
}

interface Locked {
  jobClass: JobClass
  runId: string
  finishedAt: Date | null
  deadAt: Date | null
}

// The lock order of the work engine, everywhere: the job's input row, then its run row, then the writes.
// A worker's result post, an attempt start and a dead-letter action therefore never wait on each other in a
// circle.
async function lockJob(client: PoolClient, jobId: string): Promise<Locked> {
  const job = await client.query<{ class: JobClass; run_id: string; finished_at: Date | null }>(
    'select class, run_id, finished_at from app.job_input where job_id = $1 for update',
    [jobId],
  )
  const row = job.rows[0]
  if (!row) throw new AppError(404, 'job_not_found', 'No such job.')
  await client.query('select 1 from app.run where id = $1 for update', [row.run_id])
  const control = await client.query<{ dead_at: Date | null }>(
    'select dead_at from app.job_control where job_id = $1',
    [jobId],
  )
  return {
    jobClass: row.class,
    runId: row.run_id,
    finishedAt: row.finished_at,
    deadAt: control.rows[0]?.dead_at ?? null,
  }
}

// Called by the worker's dead-letter watcher when the library has given up on a job. Repeating it is safe.
export async function markDead(deps: JobsDeps, jobId: string): Promise<void> {
  const brandId = await brandOf(deps, jobId)
  await withBrand(deps.pool, brandId, async (client) => {
    const job = await lockJob(client, jobId)
    // A job whose result was already applied is not dead, whatever a late copy says.
    if (job.finishedAt) return
    // Nor is a job the queue is running again: a redelivered copy, or the reconciliation, arriving after an
    // owner's requeue must not fail the run or the live attempt. The queue's own record decides.
    if ((await deps.queue.state(job.jobClass, jobId)) !== 'failed') return
    await client.query(
      'update app.job_control set dead_at = coalesce(dead_at, now()), updated_at = now() where job_id = $1',
      [jobId],
    )
    // The attempt the library gave up on never reported an end (a handler's throw tells the core nothing):
    // it ends here, so a dead job has no active attempt and a stale worker's call is refused as ended.
    await client.query(
      `update app.job_attempt set state = 'failed', ended_at = now() where job_id = $1 and state = 'active'`,
      [jobId],
    )
    await client.query(
      `update app.run set state = 'failed', finished_at = now()
        where id = $1 and state in ('created', 'running')`,
      [job.runId],
    )
    if (job.deadAt) return
    await deps.audit.record(
      { action: 'jobs.dead', actor: null, brandId, subject: jobId, outcome: 'success', detail: { jobId } },
      client,
    )
  })
}

export async function listDead(deps: JobsDeps, brandId: string): Promise<DeadJob[]> {
  return withBrand(deps.pool, brandId, async (client) => {
    const { rows } = await client.query<{
      job_id: string
      run_id: string
      class: JobClass
      dead_at: Date
      attempts: string
    }>(
      `select c.job_id, i.run_id, i.class, c.dead_at,
              (select count(*) from app.job_attempt a where a.job_id = c.job_id) as attempts
         from app.job_control c join app.job_input i on i.job_id = c.job_id
        where c.dead_at is not null and i.finished_at is null
        order by c.dead_at desc`,
    )
    return rows.map((r) => ({
      jobId: r.job_id,
      runId: r.run_id,
      jobClass: r.class,
      deadAt: r.dead_at.toISOString(),
      attempts: Number(r.attempts),
    }))
  })
}

// Note: the queue is called while the job_input and run locks are held (the queue has its own connection
// and takes no application lock, so it cannot wait on them; the cost is a longer hold on two rows).
async function requireDead(
  client: PoolClient,
  deps: JobsDeps,
  jobId: string,
): Promise<{ jobClass: JobClass; runId: string }> {
  const job = await lockJob(client, jobId)
  if (!job.deadAt || job.finishedAt) {
    throw new AppError(409, 'job_not_dead', 'This job is not in the dead-letter list.')
  }
  // The queue must agree: retry and cancel act only on a failed job, so a job the queue no longer shows as
  // failed (a requeue or cancel whose database half rolled back) is refused, and the two cannot diverge.
  if ((await deps.queue.state(job.jobClass, jobId)) !== 'failed') {
    throw new AppError(409, 'job_not_dead', 'The queue does not show this job as failed.')
  }
  return { jobClass: job.jobClass, runId: job.runId }
}

// The queue is asked first, the database second: a job the queue has retried and the database still lists
// as dead is cleared by its next attempt (startAttempt), whereas the reverse would list a job as live that
// the queue will never run.
export async function requeueJob(
  deps: JobsDeps,
  brandId: string,
  jobId: string,
  actor: string,
): Promise<void> {
  await withBrand(deps.pool, brandId, async (client) => {
    const { jobClass, runId } = await requireDead(client, deps, jobId)
    await deps.queue.requeue(jobClass, jobId)
    await client.query('update app.job_control set dead_at = null, updated_at = now() where job_id = $1', [
      jobId,
    ])
    // Only a run the dead job failed runs again; a run someone cancelled stays cancelled.
    await client.query(
      `update app.run set state = 'running', finished_at = null where id = $1 and state = 'failed'`,
      [runId],
    )
    await deps.audit.record(
      { action: 'jobs.requeued', actor, brandId, subject: jobId, outcome: 'success', detail: { jobId } },
      client,
    )
  })
}

export async function cancelJob(
  deps: JobsDeps,
  brandId: string,
  jobId: string,
  actor: string,
): Promise<void> {
  await withBrand(deps.pool, brandId, async (client) => {
    const { jobClass, runId } = await requireDead(client, deps, jobId)
    await deps.queue.cancel(jobClass, jobId)
    await client.query(
      'update app.job_control set cancel_requested = true, dead_at = null, updated_at = now() where job_id = $1',
      [jobId],
    )
    await client.query(
      `update app.run set state = 'cancelled', finished_at = now()
        where id = $1 and state in ('created', 'running', 'failed') and not exists (
          select 1 from app.job_input i join app.job_control c on c.job_id = i.job_id
           where i.run_id = $1 and i.finished_at is null and not c.cancel_requested)`,
      [runId],
    )
    await deps.audit.record(
      { action: 'jobs.cancelled', actor, brandId, subject: jobId, outcome: 'success', detail: { jobId } },
      client,
    )
  })
}

// Spec 9.5, reconciliation: a call still "started" after its class's expiry becomes "unknown".
export async function sweepModelCalls(deps: JobsDeps): Promise<number> {
  let marked = 0
  for (const jobClass of JOB_CLASSES) {
    const cutoff = new Date(deps.now().getTime() - CLASS_SETTINGS[jobClass].expireInSeconds * 1000)
    const { rows } = await deps.pool.query<{ n: number }>(
      'select app.sweep_model_calls($1::app.job_class, $2) as n',
      [jobClass, cutoff],
    )
    marked += rows[0]?.n ?? 0
  }
  return marked
}
