import type { PoolClient } from '@mkt/db'
import type { JobClass } from '@mkt/queue'
import { randomUUID } from 'node:crypto'
import { applyResult, type HeldResult, type JobsDeps } from '../jobs/service.ts'

interface Freed {
  job_id: string
  brand_id: string
  run_id: string
  class: JobClass
  held_result: Partial<HeldResult> | null
  finished_at: Date | null
  cancel_requested: boolean
}

// Lock order of the work engine, everywhere: job_input, run, approval_request, audit chain. A held result
// applied here goes through applyResult (job_input already held, then run) and its handler (a version reaching
// awaiting_approval takes approval_request locks, then writes audit entries). releaseSwitch therefore writes
// its own 'killswitch.released' entry only after this hook has run, and the approvals tick (approvals/requests.ts)
// takes approval_request before the chain, so no two of them wait on each other in a circle.
//
// What a kill-switch release does with the jobs it freed (spec 9.2, 9.4, 13), run by releaseSwitch inside the
// release transaction as its afterRelease hook, so the flag is cleared and the jobs are dealt with together,
// or neither.
//
// - A job with a held result from its current attempt: the result is applied now, through the same path as a
//   normal post (applyResult: the registered handler, the job's end, the run's state), and the job does not
//   run again.
// - A held result that is stale (its attempt is no longer the job's latest, or has ended, or the job was
//   cancelled), or that cannot be applied: it is discarded (audited), and the job runs again like any other.
// - Every other freed job is sent to the queue again under a new queue id, recorded in job_control.queue_id.
//   The library has completed the row of a job a worker claimed while it was held, and it ignores a send or a
//   retry of a completed id; a row still waiting is left alone and, when claimed, is turned away as superseded
//   by startAttempt, which accepts only the current queue id. So exactly one copy can run each job.
// - A finished or cancelled job is not sent again.
//
// Repeating a release changes nothing: releaseSwitch calls this only with jobs whose held flag it changed.
export function releaseHeldJobs(
  deps: Pick<JobsDeps, 'queue' | 'results' | 'audit'>,
): (client: PoolClient, unheldJobIds: string[]) => Promise<void> {
  return async (client, unheldJobIds) => {
    if (unheldJobIds.length === 0) return
    // releaseSwitch already locked these input rows, in id order, before hold_brand_jobs touched job_control
    // (the engine's lock order is job_input, then run, then job_control). Taking them again here is a no-op
    // that reads them; an attempt start or a result post for one of these jobs waits for the release to
    // commit, then sees the job free and its current queue id.
    const { rows } = await client.query<Freed>(
      `select i.job_id, i.brand_id, i.run_id, i.class, i.held_result, i.finished_at, c.cancel_requested
         from app.job_input i join app.job_control c on c.job_id = i.job_id
        where i.job_id = any($1::uuid[])
        order by i.job_id
        for update of i`,
      [unheldJobIds],
    )
    if (rows.length === 0) return
    const brand = await client.query<{ schedule_key: string }>(
      'select schedule_key from app.brand where id = $1',
      [rows[0]!.brand_id],
    )
    const scheduleKey = brand.rows[0]!.schedule_key

    for (const job of rows) {
      if (job.finished_at) {
        if (job.held_result) await clearHeld(client, job.job_id)
        continue
      }
      if (job.held_result) {
        const discarded = await consumeHeldResult(client, deps, job)
        if (!discarded) continue
        await deps.audit.record(
          {
            action: 'jobs.held_result_discarded',
            actor: null,
            brandId: job.brand_id,
            subject: job.job_id,
            outcome: 'success',
            detail: { jobId: job.job_id, ...discarded },
          },
          client,
        )
      }
      if (job.cancel_requested) continue
      // Known limitation: release during an in-flight call can cost one duplicate model call; the proper fix is
      // the worker ending its attempt when it stops on held. (An attempt still running when its job is freed
      // here is superseded by the new copy's attempt, whose model call is flagged possible_duplicate.)
      const queueId = randomUUID()
      await client.query('update app.job_control set queue_id = $2, updated_at = now() where job_id = $1', [
        job.job_id,
        queueId,
      ])
      await deps.queue.send(client, { jobId: job.job_id, jobClass: job.class, scheduleKey, queueId })
    }
  }
}

async function clearHeld(client: PoolClient, jobId: string): Promise<void> {
  await client.query('update app.job_input set held_result = null where job_id = $1', [jobId])
}

// Applies the held result when it is current and answers null; otherwise clears it and answers why.
// Current means: posted by the job's latest attempt, which is still active (an attempt ends when it is
// superseded by a reclaim, marked failed by the dead-letter path, or succeeds), and the job is not cancelled.
async function consumeHeldResult(
  client: PoolClient,
  deps: Pick<JobsDeps, 'results'>,
  job: Freed,
): Promise<{ reason: 'stale' | 'not_applied'; error?: string } | null> {
  const held = job.held_result!
  const latest = await client.query<{ id: string; state: string }>(
    'select id, state from app.job_attempt where job_id = $1 order by attempt_number desc limit 1',
    [job.job_id],
  )
  const attempt = latest.rows[0]
  const current =
    typeof held.type === 'string' &&
    typeof held.attemptId === 'string' &&
    attempt?.id === held.attemptId &&
    attempt.state === 'active' &&
    !job.cancel_requested
  if (!current) {
    await clearHeld(client, job.job_id)
    return { reason: 'stale' }
  }
  // A handler that throws must not make the switch impossible to release: its writes are rolled back to
  // here, the result is discarded and the job runs again (its paid-for steps are checkpointed).
  await client.query('savepoint held_result')
  try {
    await applyResult(client, deps, {
      brandId: job.brand_id,
      jobId: job.job_id,
      runId: job.run_id,
      attemptId: held.attemptId!,
      posted: { type: held.type!, result: held.result },
    })
    await client.query('release savepoint held_result')
    return null
  } catch (error) {
    await client.query('rollback to savepoint held_result')
    await clearHeld(client, job.job_id)
    return { reason: 'not_applied', error: errorName(error) }
  }
}

// The error's code (an AppError's or the database's) or its class name; never its message, which may carry
// business content into the audit log.
function errorName(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code.slice(0, 100)
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name.length > 0) return name.slice(0, 100)
  }
  return 'unknown'
}
