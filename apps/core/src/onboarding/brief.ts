import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import {
  CHOICE_KEYS,
  strategistInputSchema,
  strategyBriefAgainstInput,
  strategyBriefPayload,
  strategyBriefResultSchema,
  type BodyBlock,
  type ChoiceKey,
  type StrategistInput,
} from '@mkt/shared'
import { createVersion, moveState } from '../content/versions.ts'
import { AppError } from '../errors.ts'
import type { ResultHandler } from '../jobs/results.ts'
import { createJob, createRun, type JobsDeps } from '../jobs/service.ts'
import { buildBriefChoicesInput } from './brief-choices.ts'
import { latestStrategistJob, STRATEGIST_AGENT } from './brief-state.ts'
import { clip } from './input-text.ts'
import { researchRunIsOpen } from './runs.ts'
import { lockOnboarding } from './suggestions.ts'

// The strategy brief (spec 10): the strategist writes it from what the brief choices were made from and the
// owner's picks; it becomes the next version of the brand's one strategy_brief content item and waits in the
// inbox for the platform owner's approval, citing every fact it relies on. Approving it passes gate 1
// (approvals/service.ts). An approver never edits a brief: it changes only through "ask for changes" (Task 7),
// which starts the strategist again with a change request.

export const STRATEGY_BRIEF_RESULT_TYPE = 'strategy_brief.v1'

const PICK_MAX = 300
const NOT_TAKEN_MAX = 2
const COMMENT_MAX = 2000
const PREVIOUS_MAX = 30000
const CHOICE_KEY_SET: ReadonlySet<string> = new Set(CHOICE_KEYS)

export interface ChangeRequest {
  comment: string
  // The version the owner asked to change: its text is sent with the comment.
  previousVersionId: string
}

export type StrategistDeps = Pick<JobsDeps, 'queue' | 'backlogLimit' | 'audit' | 'now'>

export interface StartedBrief {
  runId: string
  jobId: string
  revision: number
}

const notFound = () => new AppError(404, 'not_found', 'There is nothing at this address.')

// The owner's picks: one per key, from the choices they settled that are still current (the latest decision on a
// key counts). The value picked, and the other options as the roads not taken, in their order (ruling R10).
async function picksOf(client: PoolClient, brandId: string): Promise<StrategistInput['picks']> {
  const found = await client.query<{
    key: string
    proposed: { question?: unknown } | null
    options: { value?: unknown }[] | null
    decided_value: { value?: unknown } | null
  }>(
    `select distinct on (key) key, proposed, options, decided_value
       from app.suggestion
      where brand_id = $1 and step = 'choice' and decision in ('accepted', 'edited') and superseded_by is null
      order by key, decided_at desc nulls last, created_at desc, id desc`,
    [brandId],
  )
  const text = (value: unknown): string | null => (typeof value === 'string' ? clip(value, PICK_MAX) : null)
  return found.rows
    .flatMap((row) => {
      const picked = text(row.decided_value?.value)
      const question = text(row.proposed?.question)
      if (!CHOICE_KEY_SET.has(row.key) || picked === null || question === null) return []
      const notTaken = (Array.isArray(row.options) ? row.options : [])
        .map((option) => option?.value)
        .filter((value): value is string => typeof value === 'string' && value !== picked)
        .flatMap((value) => text(value) ?? [])
        .slice(0, NOT_TAKEN_MAX)
      return [{ key: row.key as ChoiceKey, question, picked, notTaken }]
    })
    .sort((a, b) => CHOICE_KEYS.indexOf(a.key) - CHOICE_KEYS.indexOf(b.key))
}

// A brief's body as plain text: its headings, paragraphs and list items, one per line.
export function briefText(body: readonly BodyBlock[]): string {
  return body
    .flatMap((block) => {
      if (block.type === 'list') return block.items
      if (block.type === 'image') return []
      return [block.text]
    })
    .join('\n')
}

// The revision of a new brief version, derived rather than stored (plan, Task 6): 0 for a brief started on its
// own; for a change request, one more than the version the owner asked to change, which is still the brief
// item's current version (no other strategist job can run meanwhile: brief_running).
async function derivedRevision(
  client: PoolClient,
  brandId: string,
  changeRequested: boolean,
): Promise<number> {
  if (!changeRequested) return 0
  const found = await client.query<{ revision: number | null }>(
    `select (v.provenance->>'revision')::int as revision
       from app.content_item i
       join app.content_version v on v.brand_id = i.brand_id and v.id = i.current_version_id
      where i.brand_id = $1 and i.kind = 'strategy_brief'`,
    [brandId],
  )
  return (found.rows[0]?.revision ?? 0) + 1
}

// The change request as the strategist reads it: the comment and the text of the version it is about, which must
// be a version of the brand's brief.
async function changeRequestOf(
  client: PoolClient,
  brandId: string,
  request: ChangeRequest,
): Promise<NonNullable<StrategistInput['changeRequest']>> {
  const found = await client.query<{ payload_canonical: string }>(
    `select v.payload_canonical
       from app.content_version v
       join app.content_item i on i.brand_id = v.brand_id and i.id = v.content_item_id
      where v.brand_id = $1 and v.id = $2 and i.kind = 'strategy_brief'`,
    [brandId, request.previousVersionId],
  )
  const row = found.rows[0]
  if (!row) throw notFound()
  const payload = JSON.parse(row.payload_canonical) as { body?: BodyBlock[] }
  const previous = clip(briefText(payload.body ?? []), PREVIOUS_MAX)
  const comment = clip(request.comment.trim(), COMMENT_MAX)
  if (comment === null) throw new AppError(400, 'comment_needed', 'Say what should change in the brief.')
  if (previous === null) throw notFound()
  return { comment, previous }
}

// ---- Starting ----

export function startStrategist(
  pool: Pool,
  deps: StrategistDeps,
  input: { brandId: string; actor: { userId: string }; changeRequest?: ChangeRequest },
): Promise<StartedBrief> {
  return withBrand(pool, input.brandId, (client) => startStrategistWithin(client, deps, input))
}

// The same inside the caller's brand transaction (ask for changes starts the strategist within its decision). Every
// refusal comes before anything is written.
export async function startStrategistWithin(
  client: PoolClient,
  deps: StrategistDeps,
  input: { brandId: string; actor: { userId: string }; changeRequest?: ChangeRequest },
): Promise<StartedBrief> {
  await lockOnboarding(client, input.brandId)
  const onboarding = await client.query<{ early: boolean }>(
    `select step < 'brief_choices'::app.onboarding_step as early from app.onboarding where brand_id = $1`,
    [input.brandId],
  )
  if (onboarding.rows[0]?.early !== false) {
    throw new AppError(
      409,
      'brief_choices_needed',
      'Settle the brief choices first: the brief is written from your picks.',
    )
  }
  const open = await client.query(
    `select 1 from app.suggestion
      where brand_id = $1 and step = 'choice' and decision is null and superseded_by is null limit 1`,
    [input.brandId],
  )
  if (open.rows.length > 0) {
    throw new AppError(
      409,
      'choices_open',
      'Settle every brief choice first: pick an option or write your own.',
    )
  }
  const picks = await picksOf(client, input.brandId)
  if (picks.length === 0) {
    throw new AppError(
      409,
      'choices_needed',
      'Settle at least one brief choice first: the brief follows your picks.',
    )
  }
  const facts = await client.query(
    `select 1 from app.verified_fact where brand_id = $1 and status = 'active' limit 1`,
    [input.brandId],
  )
  if (facts.rows.length === 0) {
    throw new AppError(409, 'facts_needed', 'Confirm at least one fact first: the brief rests on facts.')
  }
  const job = await latestStrategistJob(client, input.brandId)
  if (job && (await researchRunIsOpen(client, job.runId))) {
    throw new AppError(
      409,
      'brief_running',
      'The brief is already being written for this brand. Wait for it, or answer its question.',
    )
  }
  const live = await client.query<{ id: string }>(
    'select id from app.agent_definition_version where live and agent = $1',
    [STRATEGIST_AGENT],
  )
  if (!live.rows[0]) {
    throw new AppError(
      503,
      'agent_unavailable',
      'The strategist has no live release yet. Release it, then start the brief again.',
    )
  }
  const changeRequest = input.changeRequest
    ? await changeRequestOf(client, input.brandId, input.changeRequest)
    : null
  const revision = await derivedRevision(client, input.brandId, changeRequest !== null)
  const jobInput: StrategistInput = strategistInputSchema.parse({
    ...(await buildBriefChoicesInput(client, input.brandId)),
    today: deps.now().toISOString().slice(0, 10),
    picks,
    baseline: null,
    changeRequest,
  })
  const runId = await createRun(client, input.brandId, {
    agent: STRATEGIST_AGENT,
    definitionVersionId: live.rows[0].id,
    startedByKind: 'user',
    startedById: input.actor.userId,
  })
  const jobId = await createJob(client, deps, input.brandId, {
    runId,
    jobClass: 'production',
    input: jobInput,
    expectedResultType: STRATEGY_BRIEF_RESULT_TYPE,
    agent: STRATEGIST_AGENT,
  })
  await deps.audit.record(
    {
      action: 'onboarding.brief_started',
      actor: input.actor.userId,
      brandId: input.brandId,
      subject: runId,
      outcome: 'success',
      detail: { runId, revision },
    },
    client,
  )
  return { runId, jobId, revision }
}

// ---- The result (strategy_brief.v1) ----

// The brand's one strategy_brief item (the unique index of migration 0031), made on the first brief.
async function briefItemOf(client: PoolClient, brandId: string): Promise<string> {
  const found = await client.query<{ id: string }>(
    `select id from app.content_item where brand_id = $1 and kind = 'strategy_brief'`,
    [brandId],
  )
  if (found.rows[0]) return found.rows[0].id
  const made = await client.query<{ id: string }>(
    `insert into app.content_item (brand_id, kind) values ($1, 'strategy_brief') returning id`,
    [brandId],
  )
  return made.rows[0]!.id
}

const unknownFact = () =>
  new AppError(
    422,
    'unknown_fact',
    "The brief cites a fact that is not one of the brand's facts in force. Cite only the facts the job was given.",
  )

// Checked again here (the worker's check is not trusted). A result that asks is not a brief: the worker raises its
// question instead. Every cited fact must be one of the job's input and still in force now (test 49): a fact
// retired or replaced since the job started refuses the brief, and nothing is written. The brief becomes the next
// version of the brand's brief item (an open earlier version is superseded), passes its facts_current check and
// waits for approval, which tells the platform owners.
export function strategyBriefResultHandler(deps: Pick<JobsDeps, 'audit'>): ResultHandler {
  return async (client, ctx) => {
    const parsed = strategyBriefResultSchema.safeParse(ctx.result)
    if (!parsed.success || parsed.data.ask !== null || parsed.data.brief === null) {
      throw new AppError(422, 'result_invalid', 'The result is not a valid strategy brief.')
    }
    await lockOnboarding(client, ctx.brandId)
    // Ids are compared in lower case, as the database writes them (a uuid is valid in either case).
    const factIds = [...new Set(parsed.data.brief.factIds.map((id) => id.toLowerCase()))]
    const brief = { ...parsed.data.brief, factIds }
    const job = await client.query<{ input: StrategistInput }>(
      'select input from app.job_input where job_id = $1',
      [ctx.jobId],
    )
    const input = job.rows[0]!.input
    const issues = strategyBriefAgainstInput({ brief, ask: null }, input)
    if (issues.some((issue) => issue.path.startsWith('brief.factIds'))) throw unknownFact()
    if (issues.length > 0)
      throw new AppError(422, 'result_invalid', 'The result is not a valid strategy brief.')
    const facts = await client.query<{ id: string; statement: string; fact_hash: string }>(
      `select id, statement, fact_hash from app.verified_fact
        where brand_id = $1 and status = 'active' and id = any($2::uuid[])`,
      [ctx.brandId, factIds],
    )
    if (facts.rows.length !== factIds.length) throw unknownFact()

    const revision = await derivedRevision(client, ctx.brandId, input.changeRequest !== null)
    const contentItemId = await briefItemOf(client, ctx.brandId)
    const actor = { kind: 'agent' as const, runId: ctx.runId }
    const version = await createVersion(client, deps, {
      brandId: ctx.brandId,
      contentItemId,
      payload: strategyBriefPayload(brief, {
        brandId: ctx.brandId,
        contentItemId,
        brandName: input.brandName,
        facts: facts.rows.map((r) => ({ id: r.id, statement: r.statement, factHash: r.fact_hash })),
      }),
      createdBy: actor,
      provenance: { source: 'strategist', revision },
    })
    await moveState(client, deps, version.versionId, 'in_checks', actor)
    // Every citation was just found current, in this transaction.
    await client.query(
      `insert into app.check_result (brand_id, content_version_id, check_name, kind, passed, detail)
       values ($1, $2, 'facts_current', 'blocking', true, $3::jsonb)`,
      [ctx.brandId, version.versionId, JSON.stringify({ cited: factIds.length })],
    )
    await moveState(client, deps, version.versionId, 'awaiting_approval', actor, 'facts_current')
    // Never backward: a brief written after onboarding is done leaves the step where it is.
    await client.query(
      `update app.onboarding set step = 'brief' where brand_id = $1 and step in ('brief_choices', 'brief')`,
      [ctx.brandId],
    )
    return { contentItemId, versionId: version.versionId, number: version.number, revision }
  }
}
