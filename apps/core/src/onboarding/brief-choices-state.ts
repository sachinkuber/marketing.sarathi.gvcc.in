import type { PoolClient } from '@mkt/db'
import { latestAgentJob, type AgentJob, type AgentJobState } from './agent-questions.ts'

// What the overview needs of the brief choices, kept apart from brief-choices.ts so that research.ts (the overview)
// imports nothing that imports it back.

export const BRIEF_CHOICES_AGENT = 'brief_choices'

// The job of the brand's latest brief choices run; null when none was ever started.
export function latestBriefChoicesJob(client: PoolClient, brandId: string): Promise<AgentJob | null> {
  return latestAgentJob(client, brandId, BRIEF_CHOICES_AGENT)
}

export interface BriefChoicesBlock {
  state: AgentJobState
  // The current choices, and those the owner has settled.
  total: number
  decided: number
}

// The overview's block: null before the first start.
export async function readBriefChoicesBlock(
  client: PoolClient,
  brandId: string,
): Promise<BriefChoicesBlock | null> {
  const job = await latestBriefChoicesJob(client, brandId)
  if (!job) return null
  const counts = await client.query<{ total: number; decided: number }>(
    `select count(*)::int as total, (count(*) filter (where decision is not null))::int as decided
       from app.suggestion where brand_id = $1 and step = 'choice' and superseded_by is null`,
    [brandId],
  )
  return { state: job.state, ...counts.rows[0]! }
}
