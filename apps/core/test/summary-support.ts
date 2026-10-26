import { startSummaryRun } from '../src/agents/start.ts'
import type { JobsDeps } from '../src/jobs/service.ts'
import { startAttempt } from '../src/jobs/service.ts'
import { verifyAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'
import type { Stack } from './support.ts'

export const BRIEF = 'Launch of the monsoon range, two lines, friendly tone.'

export const GOOD_RESULT = { summary: 'A short, friendly summary.', keywords: ['monsoon', 'range', 'launch'] }

// Starts a summary run the way the route does and returns its ids.
export async function startRun(
  jobs: JobsDeps,
  brandId: string,
  userId: string,
  brief = BRIEF,
): Promise<{ runId: string; jobId: string }> {
  return startSummaryRun(jobs.pool, jobs, { brandId, brief, actor: { userId } })
}

// Plays the worker's claim: the queue shows the job active, then the core starts an attempt for it.
export async function claim(stack: Stack, jobs: JobsDeps, jobId: string): Promise<AttemptClaims> {
  await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
    jobId,
  ])
  const started = await startAttempt(jobs, jobId, 'w1')
  if (started.finished || 'outcome' in started) throw new Error('unexpected')
  const check = verifyAttemptToken(
    jobs.attemptTokenSecret,
    started.token,
    Math.floor(jobs.now().getTime() / 1000),
  )
  if (!check.ok) throw new Error('token')
  return check.claims
}

export async function checkJobOf(stack: Stack, runId: string): Promise<string | undefined> {
  const { rows } = await stack.db.admin.query<{ job_id: string }>(
    `select job_id from app.job_input where run_id = $1 and expected_result_type = 'placeholder_check.v1'`,
    [runId],
  )
  return rows[0]?.job_id
}

export async function runState(stack: Stack, runId: string): Promise<string> {
  const { rows } = await stack.db.admin.query<{ state: string }>('select state from app.run where id = $1', [
    runId,
  ])
  return rows[0]!.state
}

export async function counts(
  stack: Stack,
  brandId: string,
): Promise<{ items: number; versions: number; requests: number; notifications: number; jobs: number }> {
  const { rows } = await stack.db.admin.query(
    `select (select count(*)::int from app.content_item where brand_id = $1) as items,
            (select count(*)::int from app.content_version where brand_id = $1) as versions,
            (select count(*)::int from app.approval_request where brand_id = $1) as requests,
            (select count(*)::int from app.notification where brand_id = $1) as notifications,
            (select count(*)::int from app.job_input where brand_id = $1) as jobs`,
    [brandId],
  )
  return rows[0]
}
