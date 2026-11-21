import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import type { JobClass } from '@mkt/queue'
import { AppError } from '../errors.ts'
import {
  endAttemptIn,
  hasOpenQuestion,
  readControl,
  requireCurrentAttempt,
  resendJob,
  type JobsDeps,
} from '../jobs/service.ts'
import type { AttemptClaims } from '../jobs/token.ts'
import { enqueueNotification } from '../notify/notifications.ts'
import { errorName, type NotifyDeps } from '../notify/ports.ts'
import { platformOwnersOf } from '../notify/recipients.ts'

// Agent questions (spec 9). An agent job that hits something it cannot settle, and that blocks its output, asks the
// owner instead of guessing: the question is stored, the attempt that asked ends, and the job waits in
// `waiting_for_answer` (not failed, not dead, not running; its run stays running). A job has at most one open
// question. While it is open, an attempt start returns `waiting_for_answer` and starts nothing (jobs/service.ts). The
// owner's answer is an owner statement (D7) and sends the job again: its next attempt is given every answer so far.
// An unanswered question is reminded every 72 hours, and never times out into a guess.
//
// Lock order (stated in full in approvals/requests.ts): the brand row, shared, then the job's input row, then the
// question, then notifications, and the audit entry last.

export const QUESTION_KIND = 'agent_question'
export const REMINDER_KIND = 'agent_question_reminder'
const REMIND_EVERY_MS = 72 * 60 * 60 * 1000

export interface RaisedQuestion {
  question: string
  why: string
  options: string[]
  suggested: string | null
}

export type AgentJobState = 'waiting' | 'running' | 'waiting_for_answer' | 'done' | 'failed'

// A job's state as the onboarding screens show it. A job with an open question waits for the owner's answer while
// it can still run; one that finished, failed or was cancelled is shown as that, whatever it asked.
export function jobState(row: {
  finished: boolean
  dead: boolean
  cancelled: boolean
  attempts: number
  openQuestion: boolean
}): AgentJobState {
  if (row.finished) return 'done'
  if (row.dead || row.cancelled) return 'failed'
  if (row.openQuestion) return 'waiting_for_answer'
  return row.attempts > 0 ? 'running' : 'waiting'
}

export interface AgentJob {
  runId: string
  jobId: string
  state: AgentJobState
  questionId?: string
}

// The job of a brand's latest run of an onboarding agent that runs one job and can ask (the questionnaire, facts
// and rules), with the question it waits on; null when the agent was never started for the brand.
export async function latestAgentJob(
  client: PoolClient,
  brandId: string,
  agent: string,
): Promise<AgentJob | null> {
  const found = await client.query<{
    run_id: string
    job_id: string
    finished: boolean
    dead: boolean
    cancelled: boolean
    attempts: number
    question_id: string | null
  }>(
    `select r.id as run_id, i.job_id, i.finished_at is not null as finished,
            coalesce(c.dead_at is not null, false) as dead, coalesce(c.cancel_requested, false) as cancelled,
            (select count(*) from app.job_attempt a where a.job_id = i.job_id)::int as attempts,
            (select q.id from app.agent_question q
              where q.brand_id = i.brand_id and q.job_id = i.job_id and q.answer is null limit 1) as question_id
       from app.run r
       join app.job_input i on i.brand_id = r.brand_id and i.run_id = r.id
       left join app.job_control c on c.job_id = i.job_id
      where r.brand_id = $1 and r.agent = $2
      order by r.started_at desc, r.id desc, i.created_at desc limit 1`,
    [brandId, agent],
  )
  const row = found.rows[0]
  if (!row) return null
  const state = jobState({
    finished: row.finished,
    dead: row.dead,
    cancelled: row.cancelled,
    attempts: row.attempts,
    openQuestion: row.question_id !== null,
  })
  return {
    runId: row.run_id,
    jobId: row.job_id,
    state,
    ...(state === 'waiting_for_answer' && row.question_id ? { questionId: row.question_id } : {}),
  }
}

// The questions the owner is asked are those whose job still waits on them: not finished, not dead, not cancelled.
// A question of a job that ended otherwise has nothing left to resume, so it is neither listed as open nor reminded.
const WAITING = `i.finished_at is null and c.dead_at is null and not c.cancel_requested`

// ---- Raising (the worker, with the attempt token) ----

// One transaction: the question is stored with the job's brand, run and job, the attempt that asked ends, every
// platform owner is told, and the raise is audited. A cancelled job is refused as at a result post (the worker then
// stops), and so is a second open question for the job.
export async function raiseAgentQuestion(
  deps: JobsDeps,
  claims: AttemptClaims,
  body: RaisedQuestion,
): Promise<{ questionId: string }> {
  return withBrand(deps.pool, claims.brandId, async (client) => {
    await client.query('select 1 from app.brand where id = $1 for share', [claims.brandId])
    await requireCurrentAttempt(client, deps, claims)
    const job = await client.query<{ run_id: string; finished_at: Date | null }>(
      'select run_id, finished_at from app.job_input where job_id = $1',
      [claims.jobId],
    )
    const row = job.rows[0]!
    if (row.finished_at) {
      throw new AppError(409, 'job_finished', 'This job has already finished, so it cannot ask a question.')
    }
    if ((await readControl(client, claims.jobId)).cancelRequested) {
      throw new AppError(409, 'job_cancelled', 'This job was cancelled.')
    }
    if (await hasOpenQuestion(client, claims.brandId, claims.jobId)) {
      throw new AppError(
        409,
        'question_open',
        'This job already has a question waiting for an answer. It can ask again once that one is answered.',
      )
    }
    const made = await client.query<{ id: string }>(
      `insert into app.agent_question (brand_id, run_id, job_id, question, why, options, suggested)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7) returning id`,
      [
        claims.brandId,
        row.run_id,
        claims.jobId,
        body.question,
        body.why,
        JSON.stringify(body.options),
        body.suggested,
      ],
    )
    const questionId = made.rows[0]!.id
    await endAttemptIn(client, deps, claims, 'waiting_for_answer')
    for (const userId of await platformOwnersOf(client)) {
      await enqueueNotification(client, {
        brandId: claims.brandId,
        userId,
        kind: QUESTION_KIND,
        subject: { kind: 'job', id: claims.jobId },
      })
    }
    await deps.audit.record(
      {
        action: 'onboarding.agent_question_raised',
        actor: null,
        actorKind: 'agent',
        brandId: claims.brandId,
        subject: questionId,
        outcome: 'success',
        detail: { questionId, jobId: claims.jobId },
      },
      client,
    )
    return { questionId }
  })
}

// ---- The owner's list and answer ----

export interface AgentQuestionView {
  id: string
  jobId: string
  runId: string
  agent: string
  question: string
  why: string
  options: string[]
  suggested: string | null
  createdAt: string
  answer: string | null
  answeredAt: string | null
}

interface QuestionRow {
  id: string
  job_id: string
  run_id: string
  agent: string
  question: string
  why: string
  options: string[]
  suggested: string | null
  created_at: Date
  answer: string | null
  answered_at: Date | null
}

const SELECT = `select q.id, q.job_id, q.run_id, coalesce(i.agent, r.agent) as agent, q.question, q.why,
                       coalesce(q.options, '[]'::jsonb) as options, q.suggested, q.created_at, q.answer, q.answered_at
                  from app.agent_question q
                  join app.job_input i on i.brand_id = q.brand_id and i.job_id = q.job_id
                  join app.job_control c on c.job_id = q.job_id
                  join app.run r on r.brand_id = q.brand_id and r.id = q.run_id`

const view = (r: QuestionRow): AgentQuestionView => ({
  id: r.id,
  jobId: r.job_id,
  runId: r.run_id,
  agent: r.agent,
  question: r.question,
  why: r.why,
  options: r.options,
  suggested: r.suggested,
  createdAt: new Date(r.created_at).toISOString(),
  answer: r.answer,
  answeredAt: r.answered_at ? new Date(r.answered_at).toISOString() : null,
})

// The open questions, oldest first (the longest wait at the top), then the 20 newest answered ones.
export async function listAgentQuestions(pool: Pool, brandId: string): Promise<AgentQuestionView[]> {
  return withBrand(pool, brandId, async (client) => {
    const open = await client.query<QuestionRow>(
      `${SELECT} where q.brand_id = $1 and q.answer is null and ${WAITING} order by q.created_at, q.id`,
      [brandId],
    )
    const answered = await client.query<QuestionRow>(
      `${SELECT} where q.brand_id = $1 and q.answer is not null order by q.answered_at desc, q.id limit 20`,
      [brandId],
    )
    return [...open.rows, ...answered.rows].map(view)
  })
}

// One transaction: the question is locked, the job must still be waiting on it, the answer is stored with who and
// when, it becomes an owner statement (kind owner_statement, result stated, stated_by, read_at the answer's time,
// the exact wording as the extract), and the job is sent to the queue again. A second answer is refused, so a double
// click re-queues the job once and writes one statement.
//
// The job's queue row completed when the question was asked (the worker ends a waiting job without a result), and
// the queue library ignores a retry of a completed row, so the job is sent again under a new queue id (resendJob,
// as a kill-switch release does). The send is in this transaction, so the job runs again if and only if the answer
// is stored; a late copy of the old row is turned away as superseded.
// A job held by a kill switch is sent too: its next start is then held, and the switch's release runs it.
export async function answerAgentQuestion(
  deps: JobsDeps,
  input: { brandId: string; questionId: string; answer: string; actor: { userId: string } },
): Promise<{ questionId: string; requeued: true }> {
  return withBrand(deps.pool, input.brandId, async (client) => {
    const brand = await client.query<{ schedule_key: string }>(
      'select schedule_key from app.brand where id = $1 for share',
      [input.brandId],
    )
    const found = await client.query<{ job_id: string }>(
      'select job_id from app.agent_question where brand_id = $1 and id = $2',
      [input.brandId, input.questionId],
    )
    const jobId = found.rows[0]?.job_id
    if (!jobId) throw new AppError(404, 'not_found', 'There is nothing at this address.')
    const job = await client.query<{ class: JobClass; finished_at: Date | null }>(
      'select class, finished_at from app.job_input where job_id = $1 for update',
      [jobId],
    )
    const question = await client.query<{ run_id: string; answer: string | null }>(
      'select run_id, answer from app.agent_question where brand_id = $1 and id = $2 for update',
      [input.brandId, input.questionId],
    )
    if (question.rows[0]!.answer !== null) {
      throw new AppError(409, 'already_answered', 'This question already has an answer. Reload to see it.')
    }
    const control = await client.query<{ cancel_requested: boolean; dead_at: Date | null }>(
      'select cancel_requested, dead_at from app.job_control where job_id = $1',
      [jobId],
    )
    if (job.rows[0]!.finished_at || control.rows[0]!.dead_at || control.rows[0]!.cancel_requested) {
      throw new AppError(
        409,
        'job_not_waiting',
        'This job is no longer waiting for an answer: it was cancelled, failed or finished. Start that step again to carry on.',
      )
    }
    const source = await client.query<{ id: string }>(
      `insert into app.research_source (brand_id, run_id, kind, result, extract, stated_by)
       values ($1, $2, 'owner_statement', 'stated', $3, $4) returning id`,
      [input.brandId, question.rows[0]!.run_id, input.answer, input.actor.userId],
    )
    // now() is the transaction's time, so the answer and its statement carry the same moment.
    await client.query(
      `update app.agent_question set answer = $3, answered_by = $4, answered_at = now(), source_id = $5
        where brand_id = $1 and id = $2`,
      [input.brandId, input.questionId, input.answer, input.actor.userId, source.rows[0]!.id],
    )
    await resendJob(client, deps, {
      jobId,
      jobClass: job.rows[0]!.class,
      scheduleKey: brand.rows[0]!.schedule_key,
    })
    await deps.audit.record(
      {
        action: 'onboarding.agent_question_answered',
        actor: input.actor.userId,
        brandId: input.brandId,
        subject: input.questionId,
        outcome: 'success',
        detail: { questionId: input.questionId, jobId },
      },
      client,
    )
    return { questionId: input.questionId, requeued: true as const }
  })
}

// ---- Reminders (the worker's timer, through the approvals tick) ----

// What one sweep did: the questions reminded, and the brands whose reminders failed (rolled back whole and logged;
// they are retried on the next sweep). failedBrands is null when the sweep could not start at all (the platform
// owners or the brands could not be listed): that is logged, and nothing was tried.
export interface ReminderSweep {
  reminded: number
  failedBrands: number | null
}

// Every question unanswered for 72 hours since it was asked, or since its last reminder, is reminded to each
// platform owner, and its reminded_at set to `now` (the caller's clock, passed as a value). The sweep has no brand
// context: it lists only the brands with a question due (app.brands_with_due_agent_questions, a definer function
// that returns brand ids alone), then works each in its own transaction, so one brand's failure does not starve the
// others. A question's row is locked (skip locked) for its reminder, so two overlapping sweeps never send the same
// one. With no platform owner there is nobody to tell, and nothing is marked reminded. It never throws: it runs on
// the approvals timer, whose counts are already committed and must still be answered.
export async function remindAgentQuestions(
  pool: Pool,
  now: Date,
  logger?: NotifyDeps['logger'],
): Promise<ReminderSweep> {
  const cutoff = new Date(now.getTime() - REMIND_EVERY_MS)
  let owners: string[]
  let brands: string[]
  try {
    owners = await platformOwnersOf(pool)
    if (owners.length === 0) return { reminded: 0, failedBrands: 0 }
    const due = await pool.query<{ id: string }>('select app.brands_with_due_agent_questions($1) as id', [
      cutoff,
    ])
    brands = due.rows.map((r) => r.id)
  } catch (error) {
    logger?.error({ err: errorName(error) }, 'agent question reminders could not list the brands')
    return { reminded: 0, failedBrands: null }
  }
  let reminded = 0
  let failedBrands = 0
  for (const brandId of brands) {
    try {
      reminded += await withBrand(pool, brandId, (client) =>
        remindBrand(client, brandId, owners, now, cutoff),
      )
    } catch (error) {
      failedBrands += 1
      logger?.error({ err: errorName(error), brand: brandId }, 'agent question reminders failed for a brand')
    }
  }
  return { reminded, failedBrands }
}

async function remindBrand(
  client: PoolClient,
  brandId: string,
  owners: string[],
  now: Date,
  cutoff: Date,
): Promise<number> {
  await client.query('select 1 from app.brand where id = $1 for share', [brandId])
  const found = await client.query<{ id: string; job_id: string }>(
    `select q.id, q.job_id
       from app.agent_question q
       join app.job_input i on i.brand_id = q.brand_id and i.job_id = q.job_id
       join app.job_control c on c.job_id = q.job_id
      where q.brand_id = $1 and q.answer is null and coalesce(q.reminded_at, q.created_at) < $2
        and ${WAITING}
      order by q.created_at, q.id
        for update of q skip locked`,
    [brandId, cutoff],
  )
  for (const row of found.rows) {
    for (const userId of owners) {
      await enqueueNotification(client, {
        brandId,
        userId,
        kind: REMINDER_KIND,
        subject: { kind: 'job', id: row.job_id },
      })
    }
    await client.query('update app.agent_question set reminded_at = $2 where id = $1', [row.id, now])
  }
  return found.rows.length
}
