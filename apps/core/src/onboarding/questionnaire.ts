import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import {
  INPUT_ADDRESS_MAX,
  INPUT_NAME_MAX,
  INPUT_VALUE_MAX,
  MAX_FINDINGS,
  MAX_SOURCES,
  PROFILE_KEYS,
  questionnaireInputSchema,
  questionnaireResultSchema,
  WHY_MAX,
  type QuestionnaireInput,
} from '@mkt/shared'
import { AppError } from '../errors.ts'
import type { ResultHandler } from '../jobs/results.ts'
import { createJob, createRun, type JobsDeps } from '../jobs/service.ts'
import { enqueueNotification } from '../notify/notifications.ts'
import { platformOwnersOf } from '../notify/recipients.ts'
import type { AuditSink } from '../ports.ts'
import type { AgentJobState } from './agent-questions.ts'
import { MERGE_RESULT_TYPE, type Intake } from './research.ts'
import { latestQuestionnaireJob, QUESTIONNAIRE_AGENT } from './questionnaire-state.ts'
import { researchRunIsOpen } from './runs.ts'
import { supersedeProfileItem } from './suggestions.ts'

// The questionnaire (spec 4, 12): the core builds the job's input from the draft profile, stores the agent's
// questions in order, saves the owner's answers as typed, and on finish turns each answer into an owner statement
// (D7) and each profile-key answer into a profile item. Lock order: the brand's onboarding row first (as
// startResearch does), then the questionnaire, then the rows below it.

export const QUESTIONNAIRE_RESULT_TYPE = 'questionnaire.v1'
export const ANSWER_MAX = 2000

const PROFILE_KEY_SET: ReadonlySet<string> = new Set(PROFILE_KEYS)
const MAX_COMPETITORS = 5

// Text the input carries is only bounded: cut to the schema's limit, and dropped when nothing is left.
const clip = (value: string, max: number): string | null => {
  const cut = value.slice(0, max)
  const safe = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
  return safe === '' ? null : safe
}
const asText = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value) ?? ''))

// ---- Starting ----

async function buildInput(
  client: PoolClient,
  brandId: string,
  intake: Intake | null,
  researchRunId: string | null,
): Promise<QuestionnaireInput> {
  const brand = await client.query<{ name: string }>('select name from app.brand where id = $1', [brandId])
  const profileRows = await client.query<{ key: string; value: unknown; status: string }>(
    `select distinct on (key) key, value, status from app.profile_item
      where brand_id = $1 and superseded_by is null order by key, created_at desc, id`,
    [brandId],
  )
  // Open: undecided suggestions of the profile step, and those the owner rejected (ruling R9). Newest first.
  const openRows = await client.query<{
    key: string
    proposed: unknown
    confidence: string
    decision: string | null
  }>(
    `select key, proposed, confidence, decision from app.suggestion
      where brand_id = $1 and step = 'profile' and superseded_by is null
        and (decision is null or decision = 'rejected')
      order by created_at desc, id limit $2`,
    [brandId, MAX_FINDINGS],
  )
  // The gaps come from the done merge job of the brand's current research run.
  const merge = researchRunId
    ? await client.query<{ outcome: { gaps?: unknown } | null }>(
        `select outcome from app.job_input
          where brand_id = $1 and run_id = $2 and expected_result_type = $3 and finished_at is not null
          order by finished_at desc, job_id limit 1`,
        [brandId, researchRunId, MERGE_RESULT_TYPE],
      )
    : { rows: [] }
  const rawGaps = merge.rows[0]?.outcome?.gaps
  const unreadable = researchRunId
    ? await client.query<{ kind: string; address: string | null }>(
        `select kind, address from app.research_source
          where brand_id = $1 and run_id = $2 and result <> 'read' and kind <> 'owner_statement'
          order by read_at, id limit $3`,
        [brandId, researchRunId, MAX_SOURCES],
      )
    : { rows: [] }

  const profile = profileRows.rows.flatMap((r) => {
    const value = clip(asText(r.value), INPUT_VALUE_MAX)
    return value && PROFILE_KEY_SET.has(r.key) ? [{ key: r.key, value, status: r.status }] : []
  })
  const open = openRows.rows.flatMap((r) => {
    const proposed = clip(asText(r.proposed), INPUT_VALUE_MAX)
    return proposed && PROFILE_KEY_SET.has(r.key)
      ? [{ key: r.key, proposed, confidence: r.confidence, rejected: r.decision === 'rejected' }]
      : []
  })
  const gaps = (Array.isArray(rawGaps) ? rawGaps : [])
    .flatMap((g: { key?: unknown; why?: unknown }) => {
      const why = typeof g?.why === 'string' ? clip(g.why, WHY_MAX) : null
      return typeof g?.key === 'string' && PROFILE_KEY_SET.has(g.key) && why ? [{ key: g.key, why }] : []
    })
    .slice(0, PROFILE_KEYS.length)
  const competitors = (intake?.competitors ?? []).slice(0, MAX_COMPETITORS).flatMap((c) => {
    const name = clip(c.name, INPUT_NAME_MAX)
    return name ? [{ name, website: c.website ? clip(c.website, INPUT_ADDRESS_MAX) : null }] : []
  })
  return questionnaireInputSchema.parse({
    brandName: clip(brand.rows[0]?.name ?? '', INPUT_NAME_MAX) ?? 'Brand',
    profile,
    open,
    gaps,
    unreadable: unreadable.rows.map((r) => ({
      kind: r.kind,
      address: r.address ? clip(r.address, INPUT_ADDRESS_MAX) : null,
    })),
    competitors,
  })
}

export async function startQuestionnaire(
  pool: Pool,
  deps: Pick<JobsDeps, 'queue' | 'backlogLimit' | 'audit'>,
  input: { brandId: string; actor: { userId: string } },
): Promise<{ runId: string; jobId: string }> {
  return withBrand(pool, input.brandId, async (client) => {
    const row = await client.query<{ step: string; intake: Intake | null; research_run_id: string | null }>(
      'select step, intake, research_run_id from app.onboarding where brand_id = $1 for update',
      [input.brandId],
    )
    const onboarding = row.rows[0]
    if (!onboarding || onboarding.step === 'intake' || onboarding.step === 'research') {
      throw new AppError(
        409,
        'profile_needed',
        'Finish the draft profile first: research must be done and its suggestions reviewed.',
      )
    }
    const unfinished = await client.query(
      'select 1 from app.questionnaire where brand_id = $1 and finished_at is null limit 1',
      [input.brandId],
    )
    const job = await latestQuestionnaireJob(client, input.brandId)
    if (unfinished.rows.length > 0) {
      throw new AppError(
        409,
        'questionnaire_open',
        'A questionnaire is already open for this brand. Finish it before starting another.',
      )
    }
    if (job && (await researchRunIsOpen(client, job.runId))) {
      throw new AppError(
        409,
        'questionnaire_open',
        'The questionnaire is still being written. Wait for it, or answer its question.',
      )
    }
    if (onboarding.research_run_id && (await researchRunIsOpen(client, onboarding.research_run_id))) {
      throw new AppError(
        409,
        'research_running',
        'Research is still running for this brand. Wait for it to finish.',
      )
    }
    const live = await client.query<{ id: string }>(
      'select id from app.agent_definition_version where live and agent = $1',
      [QUESTIONNAIRE_AGENT],
    )
    if (!live.rows[0]) {
      throw new AppError(
        503,
        'agent_unavailable',
        'The questionnaire agent has no live release yet. Release it, then start the questionnaire again.',
      )
    }
    const jobInput = await buildInput(client, input.brandId, onboarding.intake, onboarding.research_run_id)
    const runId = await createRun(client, input.brandId, {
      agent: QUESTIONNAIRE_AGENT,
      definitionVersionId: live.rows[0].id,
      startedByKind: 'user',
      startedById: input.actor.userId,
    })
    const jobId = await createJob(client, deps, input.brandId, {
      runId,
      jobClass: 'production',
      input: jobInput,
      expectedResultType: QUESTIONNAIRE_RESULT_TYPE,
      agent: QUESTIONNAIRE_AGENT,
    })
    await deps.audit.record(
      {
        action: 'onboarding.questionnaire_started',
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

// ---- The result (questionnaire.v1) ----

// Checked again here (the worker's check is not trusted). A result that asks is not a questionnaire: the worker
// raises its question instead of posting it. The questionnaire row is made with the run's id and its questions in
// order; a repeated post of the same run's result stores nothing twice.
export function questionnaireResultHandler(): ResultHandler {
  return async (client, ctx) => {
    const parsed = questionnaireResultSchema.safeParse(ctx.result)
    if (!parsed.success || parsed.data.ask !== null) {
      throw new AppError(422, 'result_invalid', 'The result is not a valid questionnaire.')
    }
    await client.query('select 1 from app.onboarding where brand_id = $1 for update', [ctx.brandId])
    const existing = await client.query<{ n: number }>(
      `select count(*)::int as n from app.question q join app.questionnaire z
         on z.brand_id = q.brand_id and z.id = q.questionnaire_id
        where z.brand_id = $1 and z.run_id = $2`,
      [ctx.brandId, ctx.runId],
    )
    if (existing.rows[0]!.n > 0) return { questions: existing.rows[0]!.n }
    const made = await client.query<{ id: string }>(
      'insert into app.questionnaire (brand_id, run_id) values ($1, $2) returning id',
      [ctx.brandId, ctx.runId],
    )
    const questionnaireId = made.rows[0]!.id
    let position = 0
    for (const question of parsed.data.questions) {
      position += 1
      await client.query(
        `insert into app.question (brand_id, questionnaire_id, key, position, text, why, suggested_answer, options)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          ctx.brandId,
          questionnaireId,
          question.key,
          position,
          question.text,
          question.why,
          question.suggestedAnswer,
          JSON.stringify(question.options),
        ],
      )
    }
    // A restart after a finish never moves the step back from facts and rules or later (ruling R15).
    await client.query(
      `update app.onboarding set step = 'questionnaire' where brand_id = $1 and step in ('profile', 'questionnaire')`,
      [ctx.brandId],
    )
    for (const userId of await platformOwnersOf(client)) {
      await enqueueNotification(client, {
        brandId: ctx.brandId,
        userId,
        kind: 'questionnaire_ready',
        subject: { kind: 'run', id: ctx.runId },
      })
    }
    return { questions: position }
  }
}

// ---- Reading ----

export interface QuestionnaireView {
  questionnaire: null | {
    id: string
    finishedAt: string | null
    questions: {
      id: string
      key: string
      position: number
      text: string
      why: string
      options: string[]
      suggestedAnswer: string | null
      answer: string | null
    }[]
  }
  job: null | { state: AgentJobState; questionId?: string }
}

export async function readQuestionnaire(pool: Pool, brandId: string): Promise<QuestionnaireView> {
  return withBrand(pool, brandId, async (client) => {
    const job = await latestQuestionnaireJob(client, brandId)
    const jobView = job
      ? { state: job.state, ...(job.questionId ? { questionId: job.questionId } : {}) }
      : null
    const found = await client.query<{ id: string; finished_at: Date | null }>(
      `select id, finished_at from app.questionnaire where brand_id = $1 and run_id = $2`,
      [brandId, job?.runId ?? null],
    )
    const z = found.rows[0]
    if (!z) return { questionnaire: null, job: jobView }
    const questions = await client.query<{
      id: string
      key: string
      position: number
      text: string
      why: string
      options: string[] | null
      suggested_answer: string | null
      answer: string | null
    }>(
      `select q.id, q.key, q.position, q.text, q.why, q.options, q.suggested_answer, a.value as answer
         from app.question q left join app.answer a on a.brand_id = q.brand_id and a.question_id = q.id
        where q.brand_id = $1 and q.questionnaire_id = $2 order by q.position`,
      [brandId, z.id],
    )
    return {
      questionnaire: {
        id: z.id,
        finishedAt: z.finished_at ? new Date(z.finished_at).toISOString() : null,
        questions: questions.rows.map((q) => ({
          id: q.id,
          key: q.key,
          position: q.position,
          text: q.text,
          why: q.why,
          options: q.options ?? [],
          suggestedAnswer: q.suggested_answer,
          answer: q.answer,
        })),
      },
      job: jobView,
    }
  })
}

// ---- Answers ----

const finishedError = () =>
  new AppError(409, 'questionnaire_finished', 'This questionnaire is finished, so its answers cannot change.')

// Saved as typed: the value is stored as given, and an empty (or blank) one deletes the answer. No audit entry,
// the dashboard sends at most one save per question per 800 ms.
export async function saveAnswer(
  pool: Pool,
  input: { brandId: string; questionId: string; value: string; actor: { userId: string } },
): Promise<{ answered: boolean }> {
  return withBrand(pool, input.brandId, async (client) => {
    await client.query('select 1 from app.onboarding where brand_id = $1 for update', [input.brandId])
    const found = await client.query<{ questionnaire_id: string }>(
      'select questionnaire_id from app.question where brand_id = $1 and id = $2',
      [input.brandId, input.questionId],
    )
    const questionnaireId = found.rows[0]?.questionnaire_id
    if (!questionnaireId) throw new AppError(404, 'not_found', 'There is nothing at this address.')
    const z = await client.query<{ finished_at: Date | null }>(
      'select finished_at from app.questionnaire where brand_id = $1 and id = $2 for update',
      [input.brandId, questionnaireId],
    )
    if (z.rows[0]!.finished_at) throw finishedError()
    if (input.value.trim() === '') {
      await client.query('delete from app.answer where brand_id = $1 and question_id = $2', [
        input.brandId,
        input.questionId,
      ])
      return { answered: false }
    }
    await client.query(
      `insert into app.answer (brand_id, question_id, value, answered_by) values ($1, $2, $3, $4)
       on conflict (brand_id, question_id)
       do update set value = excluded.value, answered_by = excluded.answered_by, answered_at = now()`,
      [input.brandId, input.questionId, input.value, input.actor.userId],
    )
    return { answered: true }
  })
}

// ---- Finishing ----

// One transaction. The onboarding row and then the questionnaire are locked, so a second finish waits, then finds
// it finished and writes nothing. Every non-empty answer becomes an owner statement (kind owner_statement, result
// stated, stated_by the user who answered, the exact wording as the extract). An answer on a profile key also
// becomes the key's current profile item, found, citing that statement (ruling R10 supersede).
export async function finishQuestionnaire(
  pool: Pool,
  deps: { audit: AuditSink },
  input: { brandId: string; actor: { userId: string } },
): Promise<{ answered: number; blank: number }> {
  return withBrand(pool, input.brandId, async (client) => {
    await client.query('select 1 from app.onboarding where brand_id = $1 for update', [input.brandId])
    const z = await client.query<{ id: string; run_id: string | null; finished_at: Date | null }>(
      `select id, run_id, finished_at from app.questionnaire where brand_id = $1
        order by created_at desc, id desc limit 1 for update`,
      [input.brandId],
    )
    const questionnaire = z.rows[0]
    if (!questionnaire) {
      throw new AppError(409, 'questionnaire_needed', 'There is no questionnaire to finish. Start one first.')
    }
    if (questionnaire.finished_at) throw finishedError()
    const rows = await client.query<{
      question_id: string
      key: string
      value: string | null
      answered_by: string | null
      answered_at: Date | null
    }>(
      `select q.id as question_id, q.key, a.value, a.answered_by, a.answered_at
         from app.question q left join app.answer a on a.brand_id = q.brand_id and a.question_id = q.id
        where q.brand_id = $1 and q.questionnaire_id = $2 order by q.position`,
      [input.brandId, questionnaire.id],
    )
    let answered = 0
    for (const row of rows.rows) {
      if (row.value === null || row.value.trim() === '') continue
      answered += 1
      const source = await client.query<{ id: string }>(
        `insert into app.research_source (brand_id, run_id, kind, result, extract, stated_by, read_at)
         values ($1, $2, 'owner_statement', 'stated', $3, $4, $5) returning id`,
        [input.brandId, questionnaire.run_id, row.value, row.answered_by, row.answered_at],
      )
      const sourceId = source.rows[0]!.id
      await client.query('update app.answer set source_id = $3 where brand_id = $1 and question_id = $2', [
        input.brandId,
        row.question_id,
        sourceId,
      ])
      if (PROFILE_KEY_SET.has(row.key)) {
        await supersedeProfileItem(client, {
          brandId: input.brandId,
          key: row.key,
          value: row.value.trim(),
          status: 'found',
          sourceIds: [sourceId],
          fromSuggestion: null,
        })
      }
    }
    const blank = rows.rows.length - answered
    await client.query(
      'update app.questionnaire set finished_at = now(), finished_by = $3 where brand_id = $1 and id = $2',
      [input.brandId, questionnaire.id, input.actor.userId],
    )
    await client.query(`update app.onboarding set step = 'facts_rules' where brand_id = $1`, [input.brandId])
    await deps.audit.record(
      {
        action: 'onboarding.questionnaire_finished',
        actor: input.actor.userId,
        brandId: input.brandId,
        subject: questionnaire.id,
        outcome: 'success',
        detail: { questionnaireId: questionnaire.id, answered, blank },
      },
      client,
    )
    return { answered, blank }
  })
}
