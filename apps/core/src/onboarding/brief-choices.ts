import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import {
  briefChoicesInputSchema,
  briefChoicesResultSchema,
  CHOICE_KEYS,
  PROFILE_KEYS,
  QUESTION_KEYS,
  QUESTION_MAX,
  type BriefChoicesInput,
} from '@mkt/shared'
import { AppError } from '../errors.ts'
import type { ResultHandler } from '../jobs/results.ts'
import { createJob, createRun, type JobsDeps } from '../jobs/service.ts'
import { enqueueNotification } from '../notify/notifications.ts'
import { platformOwnersOf } from '../notify/recipients.ts'
import type { AgentJobState } from './agent-questions.ts'
import { BRIEF_CHOICES_AGENT, latestBriefChoicesJob } from './brief-choices-state.ts'
import { latestFactsRulesJob } from './facts-rules-state.ts'
import { asText, clip } from './input-text.ts'
import { researchRunIsOpen } from './runs.ts'
import { addSuggestions, lockOnboarding, type SuggestionInput } from './suggestions.ts'

// Brief choices (spec 4, 6): the strategic choices the owner settles before the strategist writes the brief. The
// core builds the job's input from the accepted profile, the facts and rules in force and the finished
// questionnaire's answers; the agent's result becomes choice suggestions (assumed, no sources); the owner picks one
// option or writes their own (suggestions.ts, decideWithin). A choice is neither a fact nor a rule.

export const BRIEF_CHOICES_RESULT_TYPE = 'brief_choices.v1'

const PROFILE_KEY_SET: ReadonlySet<string> = new Set(PROFILE_KEYS)
const QUESTION_KEY_SET: ReadonlySet<string> = new Set(QUESTION_KEYS)
const MAX_PROFILE = 40
const MAX_FACTS = 60
const MAX_RULES = 60
const MAX_ANSWERS = 30

async function buildInput(client: PoolClient, brandId: string): Promise<BriefChoicesInput> {
  const brand = await client.query<{ name: string }>('select name from app.brand where id = $1', [brandId])
  const profileRows = await client.query<{ key: string; value: unknown; status: string }>(
    `select distinct on (key) key, value, status from app.profile_item
      where brand_id = $1 and superseded_by is null order by key, created_at desc, id`,
    [brandId],
  )
  const factRows = await client.query<{ id: string; statement: string }>(
    `select id, statement from app.verified_fact where brand_id = $1 and status = 'active'
      order by confirmed_at, id`,
    [brandId],
  )
  const ruleRows = await client.query<{ kind: string; text: string }>(
    'select kind, text from app.safety_rule where brand_id = $1 and active order by confirmed_at, id',
    [brandId],
  )
  const answerRows = await client.query<{ key: string; text: string; value: string }>(
    `select q.key, q.text, a.value
       from app.question q join app.answer a on a.brand_id = q.brand_id and a.question_id = q.id
      where q.brand_id = $1 and q.questionnaire_id = (
              select id from app.questionnaire where brand_id = $1 and finished_at is not null
               order by finished_at desc, created_at desc, id desc limit 1)
      order by q.position`,
    [brandId],
  )
  return briefChoicesInputSchema.parse({
    brandName: clip(brand.rows[0]?.name ?? '', 200) ?? 'Brand',
    profile: profileRows.rows
      .filter((r) => PROFILE_KEY_SET.has(r.key))
      .flatMap((r) => {
        const value = clip(asText(r.value), 2000)
        return value ? [{ key: r.key, value, status: r.status }] : []
      })
      .slice(0, MAX_PROFILE),
    facts: factRows.rows
      .flatMap((r) => {
        const statement = clip(r.statement, 1000)
        return statement ? [{ id: r.id, statement }] : []
      })
      .slice(0, MAX_FACTS),
    rules: ruleRows.rows
      .flatMap((r) => {
        const text = clip(r.text, 1000)
        return text ? [{ kind: r.kind, text }] : []
      })
      .slice(0, MAX_RULES),
    answers: answerRows.rows
      .filter((r) => QUESTION_KEY_SET.has(r.key) && r.value.trim() !== '')
      .flatMap((r) => {
        const question = clip(r.text, QUESTION_MAX)
        const answer = clip(r.value, 2000)
        return question && answer ? [{ key: r.key, question, answer }] : []
      })
      .slice(0, MAX_ANSWERS),
  })
}

// ---- Starting ----

export async function startBriefChoices(
  pool: Pool,
  deps: Pick<JobsDeps, 'queue' | 'backlogLimit' | 'audit'>,
  input: { brandId: string; actor: { userId: string } },
): Promise<{ runId: string; jobId: string }> {
  return withBrand(pool, input.brandId, async (client) => {
    await lockOnboarding(client, input.brandId)
    const onboarding = await client.query<{ early: boolean }>(
      `select step < 'facts_rules'::app.onboarding_step as early from app.onboarding where brand_id = $1`,
      [input.brandId],
    )
    if (onboarding.rows[0]?.early !== false) {
      throw new AppError(
        409,
        'facts_rules_needed',
        'Settle facts and rules first: the choices are made from the facts and rules you confirmed.',
      )
    }
    const open = await client.query(
      `select 1 from app.suggestion
        where brand_id = $1 and step in ('fact', 'rule') and decision is null and superseded_by is null limit 1`,
      [input.brandId],
    )
    if (open.rows.length > 0) {
      throw new AppError(
        409,
        'facts_rules_open',
        'Decide every fact and rule first: confirm, edit or drop each one.',
      )
    }
    const facts = await client.query(
      `select 1 from app.verified_fact where brand_id = $1 and status = 'active' limit 1`,
      [input.brandId],
    )
    if (facts.rows.length === 0) {
      throw new AppError(409, 'facts_needed', 'Confirm at least one fact first: the choices rest on facts.')
    }
    const factsJob = await latestFactsRulesJob(client, input.brandId)
    if (factsJob && (await researchRunIsOpen(client, factsJob.runId))) {
      throw new AppError(
        409,
        'facts_rules_running',
        'Facts and rules are still being written for this brand. Wait for them, or answer their question.',
      )
    }
    const job = await latestBriefChoicesJob(client, input.brandId)
    if (job && (await researchRunIsOpen(client, job.runId))) {
      throw new AppError(
        409,
        'brief_choices_running',
        'The brief choices are already being written for this brand. Wait for them, or answer their question.',
      )
    }
    const live = await client.query<{ id: string }>(
      'select id from app.agent_definition_version where live and agent = $1',
      [BRIEF_CHOICES_AGENT],
    )
    if (!live.rows[0]) {
      throw new AppError(
        503,
        'agent_unavailable',
        'The brief choices agent has no live release yet. Release it, then start the brief choices again.',
      )
    }
    const jobInput = await buildInput(client, input.brandId)
    const runId = await createRun(client, input.brandId, {
      agent: BRIEF_CHOICES_AGENT,
      definitionVersionId: live.rows[0].id,
      startedByKind: 'user',
      startedById: input.actor.userId,
    })
    const jobId = await createJob(client, deps, input.brandId, {
      runId,
      jobClass: 'production',
      input: jobInput,
      expectedResultType: BRIEF_CHOICES_RESULT_TYPE,
      agent: BRIEF_CHOICES_AGENT,
    })
    await deps.audit.record(
      {
        action: 'onboarding.brief_choices_started',
        actor: input.actor.userId,
        brandId: input.brandId,
        subject: runId,
        outcome: 'success',
        detail: { runId },
      },
      client,
    )
    return { runId, jobId }
  })
}

// ---- The result (brief_choices.v1) ----

// Checked again here (the worker's check is not trusted). A result that asks is not a set of choices: the worker
// raises its question instead. Each choice becomes an open suggestion with no sources, graded assumed: the agent
// proposes, the owner picks. An undecided choice with the same key is superseded, a decided one is kept.
export function briefChoicesResultHandler(deps: Pick<JobsDeps, 'audit'>): ResultHandler {
  return async (client, ctx) => {
    const parsed = briefChoicesResultSchema.safeParse(ctx.result)
    if (!parsed.success || parsed.data.ask !== null) {
      throw new AppError(422, 'result_invalid', 'The result is not a valid set of brief choices.')
    }
    await lockOnboarding(client, ctx.brandId)
    const items: SuggestionInput[] = parsed.data.choices.map((c) => ({
      step: 'choice',
      key: c.key,
      proposed: { question: c.question, value: c.options.find((o) => o.recommended)!.value },
      why: c.why,
      sourceIds: [],
      confidence: 'assumed',
      options: c.options.map((o) => ({ value: o.value, tradeOff: o.tradeOff, recommended: o.recommended })),
    }))
    await addSuggestions(client, deps, { brandId: ctx.brandId, runId: ctx.runId, items })
    // Never backward: a re-run after onboarding moved on keeps the step where it is.
    await client.query(
      `update app.onboarding set step = 'brief_choices' where brand_id = $1 and step in ('facts_rules', 'brief_choices')`,
      [ctx.brandId],
    )
    for (const userId of await platformOwnersOf(client)) {
      await enqueueNotification(client, {
        brandId: ctx.brandId,
        userId,
        kind: 'brief_choices_ready',
        subject: { kind: 'run', id: ctx.runId },
      })
    }
    return { choices: items.length }
  }
}

// ---- Reading ----

export interface BriefChoiceView {
  id: string
  key: string
  question: string
  why: string
  options: { value: string; tradeOff: string; recommended: boolean }[]
  decision: 'accepted' | 'edited' | null
  // What the owner settled on: the recommended value, another option or their own words.
  picked: string | null
}
export interface BriefChoicesView {
  job: null | { state: AgentJobState; questionId?: string }
  choices: BriefChoiceView[]
}

export async function readBriefChoices(pool: Pool, brandId: string): Promise<BriefChoicesView> {
  return withBrand(pool, brandId, async (client) => {
    const job = await latestBriefChoicesJob(client, brandId)
    // Insertion order: a result's choices share one timestamp, so they follow the order of the keys.
    const found = await client.query<{
      id: string
      key: string
      proposed: { question: string }
      why: string
      options: BriefChoiceView['options']
      decision: 'accepted' | 'edited' | null
      decided_value: { value: string } | null
    }>(
      `select id, key, proposed, why, options, decision, decided_value
         from app.suggestion
        where brand_id = $1 and step = 'choice' and superseded_by is null
        order by created_at, array_position($2::text[], key), id`,
      [brandId, CHOICE_KEYS],
    )
    return {
      job: job ? { state: job.state, ...(job.questionId ? { questionId: job.questionId } : {}) } : null,
      choices: found.rows.map((r) => ({
        id: r.id,
        key: r.key,
        question: r.proposed.question,
        why: r.why,
        options: r.options,
        decision: r.decision,
        picked: r.decided_value?.value ?? null,
      })),
    }
  })
}
