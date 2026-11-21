import type { PoolClient } from '@mkt/db'
import { latestAgentJob, type AgentJob, type AgentJobState } from './agent-questions.ts'

// What the overview needs of facts and rules, kept apart from facts-rules.ts so that research.ts (the overview)
// imports nothing that imports it back.

export const FACTS_RULES_AGENT = 'facts_rules'

// The job of the brand's latest facts and rules run; null when none was ever started.
export function latestFactsRulesJob(client: PoolClient, brandId: string): Promise<AgentJob | null> {
  return latestAgentJob(client, brandId, FACTS_RULES_AGENT)
}

export interface FactsRulesBlock {
  state: AgentJobState
  // Suggestions waiting for the owner's decision.
  openFacts: number
  openRules: number
  // What the owner confirmed and is still in force.
  activeFacts: number
  activeRules: number
}

// The overview's block: null before the first start.
export async function readFactsRulesBlock(
  client: PoolClient,
  brandId: string,
): Promise<FactsRulesBlock | null> {
  const job = await latestFactsRulesJob(client, brandId)
  if (!job) return null
  const counts = await client.query<Omit<FactsRulesBlock, 'state'>>(
    `select (select count(*) from app.suggestion
              where brand_id = $1 and step = 'fact' and decision is null and superseded_by is null)::int as "openFacts",
            (select count(*) from app.suggestion
              where brand_id = $1 and step = 'rule' and decision is null and superseded_by is null)::int as "openRules",
            (select count(*) from app.verified_fact where brand_id = $1 and status = 'active')::int as "activeFacts",
            (select count(*) from app.safety_rule where brand_id = $1 and active)::int as "activeRules"`,
    [brandId],
  )
  return { state: job.state, ...counts.rows[0]! }
}
