import type { PoolClient } from '@mkt/db'
import type { VersionState } from '../content/states.ts'
import { latestAgentJob, type AgentJob } from './agent-questions.ts'

// What the overview needs of the strategy brief, kept apart from brief.ts so that research.ts (the overview)
// imports nothing that imports it back.

export const STRATEGIST_AGENT = 'strategist'

// The automatic revisions a brief gets from "ask for changes" (app flow 5.6 point 7): a version of a higher
// revision that is closed by a change request starts nothing and waits for the owner's decision.
export const BRIEF_REVISION_LIMIT = 3

// The job of the brand's latest strategist run; null when none was ever started.
export function latestStrategistJob(client: PoolClient, brandId: string): Promise<AgentJob | null> {
  return latestAgentJob(client, brandId, STRATEGIST_AGENT)
}

export interface BriefBlock {
  itemId: string
  versionId: string
  number: number
  state: VersionState
  // The version's place in the change requests: 0 for a brief started on its own, then one more per request.
  revision: number
  // Closed by a change request at the revision limit: no new version comes until the owner decides.
  needsDecision: boolean
}

// The overview's part: the brand's brief item's latest version (null before the first brief), and gate 1, which
// is passed while that version is approved.
export async function readBriefBlock(
  client: PoolClient,
  brandId: string,
): Promise<{ brief: BriefBlock | null; gate1: boolean }> {
  const found = await client.query<{
    item_id: string
    version_id: string
    number: number
    state: VersionState
    revision: number
    changes_requested: boolean
  }>(
    `select i.id as item_id, v.id as version_id, v.number, s.state,
            coalesce((v.provenance->>'revision')::int, 0) as revision,
            exists (select 1 from app.approval a
                     where a.brand_id = v.brand_id and a.content_version_id = v.id
                       and a.decision = 'changes_requested') as changes_requested
       from app.content_item i
       join app.content_version v on v.brand_id = i.brand_id and v.id = i.current_version_id
       join app.content_version_state s on s.brand_id = v.brand_id and s.content_version_id = v.id
      where i.brand_id = $1 and i.kind = 'strategy_brief'`,
    [brandId],
  )
  const row = found.rows[0]
  if (!row) return { brief: null, gate1: false }
  return {
    brief: {
      itemId: row.item_id,
      versionId: row.version_id,
      number: row.number,
      state: row.state,
      revision: row.revision,
      needsDecision:
        row.state === 'rejected' && row.changes_requested && row.revision >= BRIEF_REVISION_LIMIT,
    },
    gate1: row.state === 'approved',
  }
}
