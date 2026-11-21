import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'

// Candidate evaluation cases (spec 11, C8). The owner adds a correction (an edited or rejected suggestion) or an
// example of good or bad writing; a developer later turns candidates into case files in a reviewed pull request.
// The table is not readable by the app role: only app.add_evaluation_case writes it.
interface Deps {
  audit: AuditSink
}

// The agent that made a suggestion with no run recorded.
const AGENT_OF_STEP: Record<string, string> = {
  profile: 'research_merge',
  question: 'questionnaire',
  fact: 'facts_rules',
  rule: 'facts_rules',
  choice: 'brief_choices',
}

const pgCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined

async function addCase(
  client: PoolClient,
  deps: Deps,
  input: { brandId: string; agent: string; body: Record<string, unknown>; actor: { userId: string } },
): Promise<{ caseId: string }> {
  let caseId: string
  // A savepoint, so a refused add leaves the transaction usable and nothing half done.
  await client.query('savepoint add_case')
  try {
    const made = await client.query<{ id: string }>(
      'select app.add_evaluation_case($1, $2, $3::jsonb, $4) as id',
      [input.agent, input.brandId, JSON.stringify(input.body), input.actor.userId],
    )
    caseId = made.rows[0]!.id
  } catch (error) {
    await client.query('rollback to savepoint add_case')
    const code = pgCode(error)
    if (code === '23505')
      throw new AppError(409, 'already_added', 'This correction is already a candidate case.')
    if (code === '22023')
      throw new AppError(
        400,
        'case_not_accepted',
        'This case cannot be stored: keep the text and note short enough, and try again.',
      )
    throw error
  }
  await deps.audit.record(
    {
      action: 'evaluation.case_added',
      actor: input.actor.userId,
      brandId: input.brandId,
      subject: caseId,
      outcome: 'success',
      detail: { caseId, agent: input.agent },
    },
    client,
  )
  return { caseId }
}

interface SuggestionCaseRow {
  id: string
  run_id: string | null
  step: string
  key: string
  proposed: unknown
  decision: string | null
  decided_value: unknown
  decided_reason: string | null
  agent: string | null
}

export async function addCorrectionCase(
  pool: Pool,
  deps: Deps,
  input: { brandId: string; suggestionId: string; note?: string; actor: { userId: string } },
): Promise<{ caseId: string }> {
  return withBrand(pool, input.brandId, async (client) => {
    const found = await client.query<SuggestionCaseRow>(
      `select s.id, s.run_id, s.step, s.key, s.proposed, s.decision, s.decided_value, s.decided_reason, r.agent
         from app.suggestion s left join app.run r on r.id = s.run_id and r.brand_id = s.brand_id
        where s.brand_id = $1 and s.id = $2`,
      [input.brandId, input.suggestionId],
    )
    const row = found.rows[0]
    if (!row) throw new AppError(404, 'not_found', 'There is nothing at this address.')
    if (row.decision !== 'edited' && row.decision !== 'rejected')
      throw new AppError(
        409,
        'not_a_correction',
        'Only a suggestion you edited or rejected can be added as a case. Decide it first.',
      )
    const agent = row.agent ?? AGENT_OF_STEP[row.step]
    if (!agent) throw new AppError(409, 'not_a_correction', 'This suggestion has no agent to add a case for.')
    return addCase(client, deps, {
      brandId: input.brandId,
      agent,
      actor: input.actor,
      body: {
        kind: 'correction',
        suggestionId: row.id,
        runId: row.run_id,
        step: row.step,
        key: row.key,
        proposed: row.proposed,
        decision: row.decision,
        decidedValue: row.decided_value,
        reason: row.decided_reason,
        note: input.note ?? null,
      },
    })
  })
}

export async function addExampleCase(
  pool: Pool,
  deps: Deps,
  input: {
    brandId: string
    example: 'good' | 'bad'
    text: string
    note?: string
    actor: { userId: string }
  },
): Promise<{ caseId: string }> {
  return withBrand(pool, input.brandId, (client) =>
    addCase(client, deps, {
      brandId: input.brandId,
      agent: 'strategist',
      actor: input.actor,
      body: { kind: 'example', example: input.example, text: input.text, note: input.note ?? null },
    }),
  )
}
