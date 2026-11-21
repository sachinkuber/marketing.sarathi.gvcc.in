import type { PoolClient } from '@mkt/db'
import { latestAgentJob, type AgentJobState } from './agent-questions.ts'

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
  const job = await latestAgentJob(client, brandId, QUESTIONNAIRE_AGENT)
  if (!job) return null
  return { runId: job.runId, state: job.state, ...(job.questionId ? { questionId: job.questionId } : {}) }
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
