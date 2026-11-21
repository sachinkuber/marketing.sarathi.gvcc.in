import type { PoolClient } from '@mkt/db'
import { jobState, type AgentJobState } from './agent-questions.ts'

export const QUESTIONNAIRE_AGENT = 'questionnaire'

export interface QuestionnaireJob {
  runId: string
  state: AgentJobState
  questionId?: string
}

// The job of the brand's latest questionnaire run; null when none was ever started.
export async function latestQuestionnaireJob(
  client: PoolClient,
  brandId: string,
): Promise<QuestionnaireJob | null> {
  const found = await client.query<{
    run_id: string
    finished: boolean
    dead: boolean
    cancelled: boolean
    attempts: number
    question_id: string | null
  }>(
    `select r.id as run_id, i.finished_at is not null as finished,
            coalesce(c.dead_at is not null, false) as dead, coalesce(c.cancel_requested, false) as cancelled,
            (select count(*) from app.job_attempt a where a.job_id = i.job_id)::int as attempts,
            (select q.id from app.agent_question q
              where q.brand_id = i.brand_id and q.job_id = i.job_id and q.answer is null limit 1) as question_id
       from app.run r
       join app.job_input i on i.brand_id = r.brand_id and i.run_id = r.id
       left join app.job_control c on c.job_id = i.job_id
      where r.brand_id = $1 and r.agent = $2
      order by r.started_at desc, r.id desc, i.created_at desc limit 1`,
    [brandId, QUESTIONNAIRE_AGENT],
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
    state,
    ...(state === 'waiting_for_answer' && row.question_id ? { questionId: row.question_id } : {}),
  }
}

export interface QuestionnaireBlock {
  state: AgentJobState
  total: number
  answered: number
  finished: boolean
}

// The overview's block: null before the first start.
export async function readQuestionnaireBlock(
  client: PoolClient,
  brandId: string,
): Promise<QuestionnaireBlock | null> {
  const job = await latestQuestionnaireJob(client, brandId)
  if (!job) return null
  // The questionnaire of the latest job's run: none until that run's questions arrive (a restart after a finish
  // shows an empty one, not the finished one).
  const counts = await client.query<{ total: number; answered: number; finished: boolean }>(
    `select (select count(*) from app.question where brand_id = $1 and questionnaire_id = z.id)::int as total,
            (select count(*) from app.answer a join app.question q on q.brand_id = a.brand_id and q.id = a.question_id
              where a.brand_id = $1 and q.questionnaire_id = z.id)::int as answered,
            z.finished_at is not null as finished
       from app.questionnaire z where z.brand_id = $1 and z.run_id = $2`,
    [brandId, job.runId],
  )
  const c = counts.rows[0]
  return {
    state: job.state,
    total: c?.total ?? 0,
    answered: c?.answered ?? 0,
    finished: c?.finished ?? false,
  }
}
