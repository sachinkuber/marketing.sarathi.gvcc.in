import { withBrand, type Pool } from '@mkt/db'
import { z } from 'zod'
import { AppError } from '../errors.ts'
import { createJob, createRun, type JobsDeps } from '../jobs/service.ts'
import type { AuditSink } from '../ports.ts'
import { readBriefChoicesBlock, type BriefChoicesBlock } from './brief-choices-state.ts'
import { readBriefBlock, type BriefBlock, type BriefJob } from './brief-state.ts'
import { readFactsRulesBlock, type FactsRulesBlock } from './facts-rules-state.ts'
import { readQuestionnaireBlock, type QuestionnaireBlock } from './questionnaire-state.ts'
import { researchRunIsOpen } from './runs.ts'

// Owner intake (spec 4) and starting research (spec 8.1).
const httpsUrl = z
  .string()
  .max(300, 'This address is too long: use at most 300 characters.')
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:'
    } catch {
      return false
    }
  }, 'Use a full https:// address.')

export const intakeSchema = z.strictObject({
  website: httpsUrl,
  socials: z.strictObject({
    instagram: httpsUrl.optional(),
    facebook: httpsUrl.optional(),
    linkedin: httpsUrl.optional(),
    youtube: httpsUrl.optional(),
  }),
  competitors: z
    .array(
      z.strictObject({
        name: z
          .string()
          .trim()
          .min(1, 'Give each competitor a name.')
          .max(120, 'A competitor name can be at most 120 characters.'),
        website: httpsUrl.optional(),
      }),
    )
    .max(5, 'List at most 5 competitors.'),
})
export type Intake = z.infer<typeof intakeSchema>

export const GROUPS = ['site', 'social', 'visibility', 'competitors'] as const
// Both agents must have a live release before research starts.
const START_AGENTS = ['research', 'research_merge'] as const
// The agents whose model calls count in the onboarding cost (spec 14); a later onboarding agent widens only this
// list.
const COST_AGENTS = [
  'research',
  'research_merge',
  'questionnaire',
  'facts_rules',
  'brief_choices',
  'strategist',
] as const
export const GROUP_RESULT_TYPE = 'research_group.v1'
export const MERGE_RESULT_TYPE = 'research.v1'

export async function saveIntake(
  pool: Pool,
  deps: { audit: AuditSink },
  input: { brandId: string; intake: Intake; actor: { userId: string } },
): Promise<void> {
  await withBrand(pool, input.brandId, async (client) => {
    await client.query(
      `insert into app.onboarding (brand_id, intake) values ($1, $2::jsonb)
       on conflict (brand_id) do update set intake = excluded.intake`,
      [input.brandId, JSON.stringify(input.intake)],
    )
    await deps.audit.record(
      {
        action: 'onboarding.intake_saved',
        actor: input.actor.userId,
        brandId: input.brandId,
        subject: input.brandId,
        outcome: 'success',
        detail: {
          socials: Object.keys(input.intake.socials).length,
          competitors: input.intake.competitors.length,
        },
      },
      client,
    )
  })
}

export async function startResearch(
  pool: Pool,
  deps: Pick<JobsDeps, 'queue' | 'backlogLimit' | 'audit'>,
  input: { brandId: string; actor: { userId: string } },
): Promise<{ runId: string; jobIds: string[] }> {
  return withBrand(pool, input.brandId, async (client) => {
    const row = await client.query<{ intake: Intake | null; research_run_id: string | null }>(
      'select intake, research_run_id from app.onboarding where brand_id = $1 for update',
      [input.brandId],
    )
    const onboarding = row.rows[0]
    if (!onboarding?.intake?.website) {
      throw new AppError(409, 'intake_needed', 'Save the website address first, then start research.')
    }
    if (onboarding.research_run_id && (await researchRunIsOpen(client, onboarding.research_run_id))) {
      throw new AppError(
        409,
        'research_running',
        'Research is already running for this brand. Wait for it to finish.',
      )
    }
    // Both releases are checked before anything is written, so a refusal leaves nothing behind.
    const live = await client.query<{ id: string; agent: string }>(
      'select id, agent from app.agent_definition_version where live and agent = any($1::text[])',
      [START_AGENTS],
    )
    const research = live.rows.find((r) => r.agent === 'research')
    if (!research || !live.rows.some((r) => r.agent === 'research_merge')) {
      throw new AppError(
        503,
        'agent_unavailable',
        'The research agents have no live release yet. Release both research agents, then start research again.',
      )
    }
    const documents = await client.query<{ id: string }>(
      'select id from app.brand_document where brand_id = $1 order by uploaded_at, id',
      [input.brandId],
    )
    const runId = await createRun(client, input.brandId, {
      agent: 'research',
      definitionVersionId: research.id,
      startedByKind: 'user',
      startedById: input.actor.userId,
    })
    const inputs: Record<string, unknown>[] = GROUPS.map((group) => ({ group, intake: onboarding.intake }))
    if (documents.rows.length > 0) {
      inputs.push({
        group: 'documents',
        intake: onboarding.intake,
        documentIds: documents.rows.map((d) => d.id),
      })
    }
    const jobIds: string[] = []
    for (const jobInput of inputs) {
      jobIds.push(
        await createJob(client, deps, input.brandId, {
          runId,
          jobClass: 'production',
          input: jobInput,
          expectedResultType: GROUP_RESULT_TYPE,
          agent: 'research',
        }),
      )
    }
    await client.query(
      `update app.onboarding set research_run_id = $2, step = 'research' where brand_id = $1`,
      [input.brandId, runId],
    )
    await deps.audit.record(
      {
        action: 'onboarding.research_started',
        actor: input.actor.userId,
        brandId: input.brandId,
        subject: runId,
        outcome: 'success',
        detail: { runId, groups: inputs.length },
      },
      client,
    )
    return { runId, jobIds }
  })
}

// CONTRACT with Task 9: a finished group job's stored outcome (job_input.outcome) is
// { group, sources: [{ ref, id }], findings }, where id is the research_source row the group result stored.
// The overview lists a group's sources from that outcome; until the group is done there are none.
type State = 'waiting' | 'running' | 'done' | 'failed'
interface Money {
  usdMicros: string | null
  inrMicros: string | null
}
export interface GroupView {
  group: string
  state: State
  searches: number
  fetches: number
  cost: Money
  sources: {
    id: string
    kind: string
    address: string | null
    documentName: string | null
    result: string
    flagged: boolean
  }[]
}
export interface Overview {
  step: string
  intake: Intake | null
  documents: number
  research: null | {
    runId: string
    state: string
    groups: GroupView[]
    merge: State
    // What the merge could not settle (R38): the draft profile shows these as questions still to ask.
    gaps: { key: string; why: string }[]
  }
  openSuggestions: number
  // The questionnaire's state and progress; null before the first start.
  questionnaire: QuestionnaireBlock | null
  // Facts and rules: the job state, the suggestions waiting and what is in force; null before the first start.
  factsRules: FactsRulesBlock | null
  // The brief choices: the job state and how many choices the owner has settled; null before the first start.
  briefChoices: BriefChoicesBlock | null
  // The strategy brief's latest version (null before the first brief), the latest strategist job (null before the
  // first start; it shows the first brief being written, before any version), and gate 1: passed while the latest
  // version is approved.
  brief: BriefBlock | null
  briefJob: BriefJob | null
  gate1: boolean
  cost: Money
}

// Only the stored values: a call still in flight has no price yet, and a failed one costs nothing.
const money = (usd: string | null, inr: string | null, uncosted: boolean): Money =>
  uncosted ? { usdMicros: null, inrMicros: null } : { usdMicros: usd ?? '0', inrMicros: inr ?? '0' }

export async function readOverview(pool: Pool, brandId: string): Promise<Overview> {
  return withBrand(pool, brandId, async (client) => {
    const ob = await client.query<{ step: string; intake: Intake | null; research_run_id: string | null }>(
      'select step, intake, research_run_id from app.onboarding where brand_id = $1',
      [brandId],
    )
    const counts = await client.query<{ documents: number; open: number }>(
      `select (select count(*) from app.brand_document where brand_id = $1)::int as documents,
              (select count(*) from app.suggestion where brand_id = $1 and decision is null and superseded_by is null)::int as open`,
      [brandId],
    )
    const total = await client.query<{ usd: string | null; inr: string | null; uncosted: number }>(
      `select sum(m.usd_micros)::text as usd, sum(m.inr_micros)::text as inr,
              count(*) filter (where m.status in ('succeeded', 'unknown') and m.usd_micros is null)::int as uncosted
         from app.model_call m join app.run r on r.id = m.run_id
        where m.brand_id = $1 and r.agent = any($2::text[])`,
      [brandId, COST_AGENTS],
    )
    const t = total.rows[0]!
    const overview: Overview = {
      step: ob.rows[0]?.step ?? 'intake',
      intake: ob.rows[0]?.intake ?? null,
      documents: counts.rows[0]!.documents,
      research: null,
      openSuggestions: counts.rows[0]!.open,
      questionnaire: await readQuestionnaireBlock(client, brandId),
      factsRules: await readFactsRulesBlock(client, brandId),
      briefChoices: await readBriefChoicesBlock(client, brandId),
      ...(await readBriefBlock(client, brandId)),
      cost: money(t.usd, t.inr, t.uncosted > 0),
    }
    const runId = ob.rows[0]?.research_run_id
    if (!runId) return overview
    const run = await client.query<{ state: string }>('select state from app.run where id = $1', [runId])
    const jobs = await client.query<{
      job_id: string
      type: string
      group: string | null
      finished: boolean
      outcome: { sources?: { id: string }[]; gaps?: { key: string; why: string }[] } | null
      dead: boolean
      cancelled: boolean
      attempts: number
      searches: number
      fetches: number
      usd: string | null
      inr: string | null
      uncosted: number
    }>(
      `select i.job_id, i.expected_result_type as type, i.input->>'group' as "group",
              i.finished_at is not null as finished, i.outcome,
              coalesce(c.dead_at is not null, false) as dead, coalesce(c.cancel_requested, false) as cancelled,
              (select count(*) from app.job_attempt a where a.job_id = i.job_id)::int as attempts,
              coalesce(sum(m.server_tool_searches), 0)::int as searches,
              coalesce(sum(m.server_tool_fetches), 0)::int as fetches,
              sum(m.usd_micros)::text as usd, sum(m.inr_micros)::text as inr,
              count(m) filter (where m.status in ('succeeded', 'unknown') and m.usd_micros is null)::int as uncosted
         from app.job_input i
         left join app.job_control c on c.job_id = i.job_id
         left join app.model_call m on m.job_id = i.job_id
        where i.run_id = $1
        group by i.job_id, i.expected_result_type, i.input, i.finished_at, i.outcome, c.dead_at, c.cancel_requested, i.created_at
        order by i.created_at, i.job_id`,
      [runId],
    )
    const stateOf = (j: (typeof jobs.rows)[number]): State =>
      j.finished ? 'done' : j.dead || j.cancelled ? 'failed' : j.attempts > 0 ? 'running' : 'waiting'
    const groups: GroupView[] = []
    // The jobs are made in one transaction, so their creation times tie: the groups are shown in their fixed order.
    const order = (g: string | null) => [...GROUPS, 'documents'].indexOf(g ?? '')
    const groupJobs = jobs.rows
      .filter((r) => r.type === GROUP_RESULT_TYPE)
      .sort((a, b) => order(a.group) - order(b.group))
    for (const j of groupJobs) {
      const ids = (j.outcome?.sources ?? []).map((s) => s.id)
      const sources =
        ids.length === 0
          ? []
          : (
              await client.query<{
                id: string
                kind: string
                address: string | null
                document_name: string | null
                result: string
                flagged: boolean
              }>(
                `select s.id, s.kind, s.address, d.file_name as document_name, s.result,
                        left(s.extract, 9) = '[flagged:' as flagged
                   from app.research_source s
                   left join app.brand_document d on d.brand_id = s.brand_id and d.id = s.document_id
                  where s.brand_id = $1 and s.id = any($2::uuid[])
                  order by array_position($2::uuid[], s.id)`,
                [brandId, ids],
              )
            ).rows
      groups.push({
        group: j.group ?? '',
        state: stateOf(j),
        searches: j.searches,
        fetches: j.fetches,
        cost: money(j.usd, j.inr, j.uncosted > 0),
        sources: sources.map((s) => ({
          id: s.id,
          kind: s.kind,
          address: s.address,
          documentName: s.document_name,
          result: s.result,
          flagged: s.flagged,
        })),
      })
    }
    const merge = jobs.rows.find((r) => r.type === MERGE_RESULT_TYPE)
    const state = run.rows[0]?.state ?? 'failed'
    // With no merge job, the merge waits only while the run is still going: a run that ended without one (every
    // group died) will never make it, so it reads as failed and the screens stop waiting.
    const going = state === 'created' || state === 'running'
    overview.research = {
      runId,
      state,
      groups,
      merge: merge ? stateOf(merge) : going ? 'waiting' : 'failed',
      gaps: merge?.finished && Array.isArray(merge.outcome?.gaps) ? merge.outcome.gaps : [],
    }
    return overview
  })
}
