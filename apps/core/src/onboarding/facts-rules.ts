import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import {
  DOCUMENT_NAME_MAX,
  factsRulesAgainstInput,
  factsRulesInputSchema,
  factsRulesResultSchema,
  INPUT_ADDRESS_MAX,
  INPUT_EXTRACT_MAX,
  INPUT_NAME_MAX,
  INPUT_VALUE_MAX,
  MAX_INPUT_SOURCES,
  MAX_QUESTIONS,
  MAX_SOURCES,
  PROFILE_KEYS,
  QUESTION_KEYS,
  QUESTION_MAX,
  RESEARCH_SOURCE_KINDS,
  type FactsRulesInput,
  type SafetyRuleKind,
} from '@mkt/shared'
import { AppError } from '../errors.ts'
import type { ResultHandler } from '../jobs/results.ts'
import { createJob, createRun, type JobsDeps } from '../jobs/service.ts'
import { enqueueNotification } from '../notify/notifications.ts'
import { platformOwnersOf } from '../notify/recipients.ts'
import type { AuditSink } from '../ports.ts'
import type { AgentJobState } from './agent-questions.ts'
import { FACTS_RULES_AGENT, latestFactsRulesJob } from './facts-rules-state.ts'
import { asText, clip } from './input-text.ts'
import { researchRunIsOpen } from './runs.ts'
import { qualifiesAsFactSource, type SourceKind } from './sources.ts'
import { readStoredExtract } from './stored-extract.ts'
import {
  addSuggestions,
  confirmedTwin,
  decideWithin,
  factHash,
  insertSuggestion,
  listSuggestionsWithin,
  lockOnboarding,
  refuseActiveFactTwin,
  refuseActiveRuleTwin,
  sourcesJson,
  sourceViews,
  type SourceView,
  type SuggestionInput,
  type SuggestionView,
} from './suggestions.ts'

// Facts and rules (spec 5, 7, 8.2; tests 43, 44, 45). The core builds the job's input from the accepted profile,
// the finished questionnaire's answers and the brand's documents; the agent's result becomes fact and rule
// suggestions; nothing becomes a verified fact or a safety rule but by the owner: a decision on a suggestion, an
// own addition, or a change to what is confirmed. A confirmed fact or rule is never updated in place: a change
// supersedes, retires or turns it off, and the audit records who. One fact is in force per statement, and one rule
// per kind and text (ruling R20).
//
// Lock order: every function here takes the brand's onboarding row first (as starting research, the questionnaire,
// a decision and accept-all do; the result handler after the job and run rows the engine holds), then the
// suggestion, fact or rule rows. So the check for a fact or rule already in force sees every earlier confirmation.

export const FACTS_RULES_RESULT_TYPE = 'facts_rules.v1'
// The owner's own fact or rule (the result schema's limits).
export const OWN_TEXT_MAX = 300

const PROFILE_KEY_SET: ReadonlySet<string> = new Set(PROFILE_KEYS)
const QUESTION_KEY_SET: ReadonlySet<string> = new Set(QUESTION_KEYS)
const RESEARCH_KINDS: readonly string[] = RESEARCH_SOURCE_KINDS
const OWN_WHY = 'Added by the owner, in their own words.'

// The keys a re-run supersedes by (M8 addSuggestions): the first 12 hex characters of the sha256 of the normalised
// text, which is a fact's own hash, so the same fact or rule in other spacing or case has the same key.
const hash12 = (text: string) => factHash(text).slice(0, 12)
export const factKey = (statement: string) => `fact:${hash12(statement)}`
export const ruleKey = (kind: string, text: string) => `rule:${kind}:${hash12(text)}`

// ---- Starting ----

interface SourceRow {
  id: string
  kind: SourceKind
  address: string | null
  result: string
  extract: string
  document_name: string | null
}

type InputSource = FactsRulesInput['sources'][number]

// A source the agent may cite. An owner statement is sent exactly as stated, never cut (an answer is at most 2,000
// characters). A research source is sent read apart from its stored marker, only when it was read and is not
// flagged (ruling R17): a flagged page or a page that could not be read never supports a fact.
function inputSource(row: SourceRow): InputSource | null {
  const base = {
    id: row.id,
    kind: row.kind,
    address: row.address === null ? null : clip(row.address, INPUT_ADDRESS_MAX),
    documentName: row.document_name === null ? null : clip(row.document_name, DOCUMENT_NAME_MAX),
  }
  if (!RESEARCH_KINDS.includes(row.kind)) return row.extract === '' ? null : { ...base, extract: row.extract }
  if (row.result !== 'read') return null
  const { extract, flagged } = readStoredExtract(row.extract)
  const text = clip(extract, INPUT_EXTRACT_MAX)
  return flagged || text === null ? null : { ...base, extract: text }
}

async function buildInput(
  client: PoolClient,
  brandId: string,
  questionnaireId: string,
  today: string,
): Promise<FactsRulesInput> {
  const brand = await client.query<{ name: string }>('select name from app.brand where id = $1', [brandId])
  const profileRows = await client.query<{
    key: string
    value: unknown
    status: string
    source_ids: string[]
  }>(
    `select distinct on (key) key, value, status, source_ids from app.profile_item
      where brand_id = $1 and superseded_by is null order by key, created_at desc, id`,
    [brandId],
  )
  // The finished questionnaire's non-blank answers, each with the owner statement that records it.
  const answerRows = await client.query<{ key: string; text: string; value: string; source_id: string }>(
    `select q.key, q.text, a.value, a.source_id
       from app.question q join app.answer a on a.brand_id = q.brand_id and a.question_id = q.id
      where q.brand_id = $1 and q.questionnaire_id = $2 and a.source_id is not null
      order by q.position`,
    [brandId, questionnaireId],
  )
  const profile = profileRows.rows.filter((r) => PROFILE_KEY_SET.has(r.key))
  const answers = answerRows.rows.filter((r) => QUESTION_KEY_SET.has(r.key)).slice(0, MAX_QUESTIONS)
  const select = `select s.id, s.kind, s.address, s.result, s.extract, d.file_name as document_name
                    from app.research_source s
                    left join app.brand_document d on d.brand_id = s.brand_id and d.id = s.document_id`
  const cited = [...new Set([...answers.map((a) => a.source_id), ...profile.flatMap((p) => p.source_ids)])]
  const citedRows = await client.query<SourceRow>(
    `${select} where s.brand_id = $1 and s.id = any($2::uuid[])`,
    [brandId, cited],
  )
  // The brand's documents as research read them, newest first: when more are read than fit, the newest are kept.
  const documentRows = await client.query<SourceRow>(
    `${select} where s.brand_id = $1 and s.kind = 'document' order by s.read_at desc, s.id`,
    [brandId],
  )
  const byId = new Map(citedRows.rows.map((r) => [r.id, r]))
  // Within the cap, the owner's statements come first, then the profile's sources, then the documents.
  const ordered = [
    ...answers.map((a) => byId.get(a.source_id)),
    ...citedRows.rows.filter((r) => !RESEARCH_KINDS.includes(r.kind)),
    ...profile.flatMap((p) => p.source_ids.map((id) => byId.get(id))),
    ...documentRows.rows,
  ]
  const sources: InputSource[] = []
  const listed = new Set<string>()
  for (const row of ordered) {
    if (!row || listed.has(row.id) || sources.length >= MAX_INPUT_SOURCES) continue
    const source = inputSource(row)
    if (!source) continue
    listed.add(row.id)
    sources.push(source)
  }
  return factsRulesInputSchema.parse({
    today,
    brandName: clip(brand.rows[0]?.name ?? '', INPUT_NAME_MAX) ?? 'Brand',
    sources,
    // A profile item cites only the sources sent: a flagged or unread one is dropped from its list.
    profile: profile.flatMap((r) => {
      const value = clip(asText(r.value), INPUT_VALUE_MAX)
      const sourceIds = [...new Set(r.source_ids)].filter((id) => listed.has(id)).slice(0, MAX_SOURCES)
      return value ? [{ key: r.key, value, status: r.status, sourceIds }] : []
    }),
    answers: answers.flatMap((r) => {
      const question = clip(r.text, QUESTION_MAX)
      return question && listed.has(r.source_id)
        ? [{ key: r.key, question, answer: r.value, sourceId: r.source_id }]
        : []
    }),
  })
}

export async function startFactsRules(
  pool: Pool,
  deps: Pick<JobsDeps, 'queue' | 'backlogLimit' | 'audit' | 'now'>,
  input: { brandId: string; actor: { userId: string } },
): Promise<{ runId: string; jobId: string }> {
  return withBrand(pool, input.brandId, async (client) => {
    await lockOnboarding(client, input.brandId)
    const questionnaire = await client.query<{ id: string }>(
      `select id from app.questionnaire where brand_id = $1 and finished_at is not null
        order by finished_at desc, created_at desc, id desc limit 1`,
      [input.brandId],
    )
    const finished = questionnaire.rows[0]
    if (!finished) {
      throw new AppError(
        409,
        'questionnaire_needed',
        'Finish the questionnaire first: facts and rules are built from its answers.',
      )
    }
    const job = await latestFactsRulesJob(client, input.brandId)
    if (job && (await researchRunIsOpen(client, job.runId))) {
      throw new AppError(
        409,
        'facts_rules_running',
        'Facts and rules are already being written for this brand. Wait for them, or answer their question.',
      )
    }
    const live = await client.query<{ id: string }>(
      'select id from app.agent_definition_version where live and agent = $1',
      [FACTS_RULES_AGENT],
    )
    if (!live.rows[0]) {
      throw new AppError(
        503,
        'agent_unavailable',
        'The facts and rules agent has no live release yet. Release it, then start facts and rules again.',
      )
    }
    // Review dates count from the server's date, in UTC.
    const today = deps.now().toISOString().slice(0, 10)
    const jobInput = await buildInput(client, input.brandId, finished.id, today)
    const runId = await createRun(client, input.brandId, {
      agent: FACTS_RULES_AGENT,
      definitionVersionId: live.rows[0].id,
      startedByKind: 'user',
      startedById: input.actor.userId,
    })
    const jobId = await createJob(client, deps, input.brandId, {
      runId,
      jobClass: 'production',
      input: jobInput,
      expectedResultType: FACTS_RULES_RESULT_TYPE,
      agent: FACTS_RULES_AGENT,
    })
    await deps.audit.record(
      {
        action: 'onboarding.facts_rules_started',
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

// ---- The result (facts_rules.v1) ----

// Checked again here (the worker's check is not trusted). A result that asks is not a set of facts and rules: the
// worker raises its question instead. Every cited id must be one of the job input's sources or the owner statement
// of one of this job's answered agent questions (ruling R11), and every review date after the input's today; any
// later date is accepted (ruling R14). The facts and rules become open suggestions (an undecided one with the same
// key is superseded, a decided one is kept); one the owner already confirmed and keeps in force is not suggested
// again. A fact or a rule is `found` when one of its sources can stand behind it (the brand's site, a document or
// the owner's statement), else `assumed` (ruling R21), so accept-all never confirms one resting on third parties.
export function factsRulesResultHandler(deps: Pick<JobsDeps, 'audit'>): ResultHandler {
  return async (client, ctx) => {
    const parsed = factsRulesResultSchema.safeParse(ctx.result)
    if (!parsed.success || parsed.data.ask !== null) {
      throw new AppError(422, 'result_invalid', 'The result is not a valid set of facts and rules.')
    }
    await lockOnboarding(client, ctx.brandId)
    // Ids are compared in lower case, as the database writes them (a uuid is valid in either case).
    const lower = (ids: string[]) => [...new Set(ids.map((id) => id.toLowerCase()))]
    const result = {
      ...parsed.data,
      facts: parsed.data.facts.map((f) => ({ ...f, sourceIds: lower(f.sourceIds) })),
      rules: parsed.data.rules.map((r) => ({ ...r, sourceIds: lower(r.sourceIds) })),
    }
    const job = await client.query<{ input: Pick<FactsRulesInput, 'today' | 'sources'> }>(
      'select input from app.job_input where job_id = $1',
      [ctx.jobId],
    )
    const answered = await client.query<{ source_id: string }>(
      `select source_id from app.agent_question where brand_id = $1 and job_id = $2 and source_id is not null`,
      [ctx.brandId, ctx.jobId],
    )
    const issues = factsRulesAgainstInput(
      result,
      job.rows[0]!.input,
      answered.rows.map((r) => ({ sourceId: r.source_id })),
    )
    if (issues.some((issue) => issue.path.includes('sourceIds'))) {
      throw new AppError(
        422,
        'source_outside_input',
        "A fact or rule cites a source that is not in this job's input. Cite only the sources the job was given.",
      )
    }
    if (issues.some((issue) => !issue.path.includes('reviewDate'))) {
      throw new AppError(422, 'result_invalid', 'The result is not a valid set of facts and rules.')
    }
    if (issues.length > 0) {
      throw new AppError(
        422,
        'review_date_not_after_today',
        "A fact's review date is not after the job's date. Give a later review date.",
      )
    }
    const cited = [...new Set([...result.facts, ...result.rules].flatMap((item) => item.sourceIds))]
    const kinds = new Map(
      (
        await client.query<{ id: string; kind: SourceKind }>(
          'select id, kind from app.research_source where brand_id = $1 and id = any($2::uuid[])',
          [ctx.brandId, cited],
        )
      ).rows.map((r) => [r.id, r.kind]),
    )
    const confirmed = new Set([
      ...(
        await client.query<{ statement: string }>(
          `select statement from app.verified_fact where brand_id = $1 and status = 'active'`,
          [ctx.brandId],
        )
      ).rows.map((r) => factKey(r.statement)),
      ...(
        await client.query<{ kind: string; text: string }>(
          'select kind, text from app.safety_rule where brand_id = $1 and active',
          [ctx.brandId],
        )
      ).rows.map((r) => ruleKey(r.kind, r.text)),
    ])
    const items: SuggestionInput[] = []
    // Each key once: the first fact or rule with a key stands for any later one in the same result.
    const keep = (key: string) => {
      if (confirmed.has(key)) return false
      confirmed.add(key)
      return true
    }
    const graded = (sourceIds: string[]) =>
      qualifiesAsFactSource(
        sourceIds.flatMap((id) => {
          const kind = kinds.get(id)
          return kind ? [kind] : []
        }),
      )
        ? ('found' as const)
        : ('assumed' as const)
    for (const f of result.facts) {
      const key = factKey(f.statement)
      if (!keep(key)) continue
      items.push({
        step: 'fact',
        key,
        proposed: { statement: f.statement, reviewDate: f.reviewDate },
        why: f.why,
        sourceIds: f.sourceIds,
        confidence: graded(f.sourceIds),
      })
    }
    for (const r of result.rules) {
      const key = ruleKey(r.kind, r.text)
      if (!keep(key)) continue
      items.push({
        step: 'rule',
        key,
        proposed: { kind: r.kind, text: r.text },
        why: r.why,
        sourceIds: r.sourceIds,
        confidence: graded(r.sourceIds),
      })
    }
    await addSuggestions(client, deps, { brandId: ctx.brandId, runId: ctx.runId, items })
    // Never backward: a re-run after onboarding moved on keeps the step where it is.
    await client.query(
      `update app.onboarding set step = 'facts_rules' where brand_id = $1 and step in ('questionnaire', 'facts_rules')`,
      [ctx.brandId],
    )
    for (const userId of await platformOwnersOf(client)) {
      await enqueueNotification(client, {
        brandId: ctx.brandId,
        userId,
        kind: 'facts_rules_ready',
        subject: { kind: 'run', id: ctx.runId },
      })
    }
    return {
      facts: items.filter((i) => i.step === 'fact').length,
      rules: items.filter((i) => i.step === 'rule').length,
    }
  }
}

// ---- Reading ----

export interface ActiveFact {
  id: string
  statement: string
  reviewDate: string
  sources: SourceView[]
}
export interface ActiveRule {
  id: string
  kind: SafetyRuleKind
  text: string
  why: string
}
export interface FactsRulesView {
  job: null | { state: AgentJobState; questionId?: string }
  facts: { suggestions: SuggestionView[]; active: ActiveFact[] }
  rules: { suggestions: SuggestionView[]; active: ActiveRule[] }
}

export async function readFactsRules(pool: Pool, brandId: string): Promise<FactsRulesView> {
  return withBrand(pool, brandId, async (client) => {
    const job = await latestFactsRulesJob(client, brandId)
    const facts = await client.query<{
      id: string
      statement: string
      review_date: string
      sources: unknown
    }>(
      `select f.id, f.statement, f.review_date::text as review_date, ${sourcesJson('f', 'source_ids')} as sources
         from app.verified_fact f where f.brand_id = $1 and f.status = 'active' order by f.confirmed_at, f.id`,
      [brandId],
    )
    const rules = await client.query<ActiveRule>(
      `select id, kind, text, why from app.safety_rule where brand_id = $1 and active order by confirmed_at, id`,
      [brandId],
    )
    return {
      job: job ? { state: job.state, ...(job.questionId ? { questionId: job.questionId } : {}) } : null,
      facts: {
        suggestions: await listSuggestionsWithin(client, brandId, 'fact'),
        active: facts.rows.map((f) => ({
          id: f.id,
          statement: f.statement,
          reviewDate: f.review_date,
          sources: sourceViews(f.sources),
        })),
      },
      rules: {
        suggestions: await listSuggestionsWithin(client, brandId, 'rule'),
        active: rules.rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, why: r.why })),
      },
    }
  })
}

// ---- The owner's own facts and rules ----

// The owner's own words as a source (D7): an owner statement, stated now by this user, the exact wording.
async function ownerStatement(
  client: PoolClient,
  brandId: string,
  text: string,
  userId: string,
): Promise<string> {
  const made = await client.query<{ id: string }>(
    `insert into app.research_source (brand_id, kind, result, extract, stated_by)
     values ($1, 'owner_statement', 'stated', $2, $3) returning id`,
    [brandId, text, userId],
  )
  return made.rows[0]!.id
}

// "Add your own" (spec 8.2, ruling R2): one transaction writes the owner statement, a suggestion citing it, and the
// owner's acceptance of it through the decision path, so the verified fact or rule has the statement as its source
// and the decision is audited as the owner's, marked as an own addition. An undecided suggestion with the same key
// is superseded by it. The same fact or rule already in force is refused before anything is written (ruling R20):
// a second tap waits for the first on the onboarding row, then finds its fact or rule.
async function addOwn(
  pool: Pool,
  deps: { audit: AuditSink },
  input: { brandId: string; actor: { userId: string } },
  own: {
    text: string
    refuseTwin: (client: PoolClient) => Promise<void>
    item: (statementId: string) => SuggestionInput
  },
): Promise<{ createdId: string; suggestionId: string }> {
  try {
    return await withBrand(pool, input.brandId, async (client) => {
      await lockOnboarding(client, input.brandId)
      await own.refuseTwin(client)
      const statementId = await ownerStatement(client, input.brandId, own.text, input.actor.userId)
      const suggestionId = await insertSuggestion(client, input.brandId, null, own.item(statementId))
      const { createdId } = await decideWithin(client, deps, {
        brandId: input.brandId,
        suggestionId,
        decision: 'accepted',
        actor: input.actor,
        ownAddition: true,
      })
      return { createdId: createdId!, suggestionId }
    })
  } catch (error) {
    throw confirmedTwin(error)
  }
}

export async function addOwnFact(
  pool: Pool,
  deps: { audit: AuditSink },
  input: { brandId: string; statement: string; reviewDate: string; actor: { userId: string } },
): Promise<{ factId: string; suggestionId: string }> {
  const { createdId, suggestionId } = await addOwn(pool, deps, input, {
    text: input.statement,
    refuseTwin: (client) => refuseActiveFactTwin(client, input.brandId, input.statement),
    item: (statementId) => ({
      step: 'fact',
      key: factKey(input.statement),
      proposed: { statement: input.statement, reviewDate: input.reviewDate },
      why: OWN_WHY,
      sourceIds: [statementId],
      confidence: 'found',
    }),
  })
  return { factId: createdId, suggestionId }
}

export async function addOwnRule(
  pool: Pool,
  deps: { audit: AuditSink },
  input: { brandId: string; kind: SafetyRuleKind; text: string; why: string; actor: { userId: string } },
): Promise<{ ruleId: string; suggestionId: string }> {
  const { createdId, suggestionId } = await addOwn(pool, deps, input, {
    text: input.text,
    refuseTwin: (client) => refuseActiveRuleTwin(client, input.brandId, input.kind, input.text),
    item: (statementId) => ({
      step: 'rule',
      key: ruleKey(input.kind, input.text),
      proposed: { kind: input.kind, text: input.text },
      why: input.why,
      sourceIds: [statementId],
      confidence: 'found',
    }),
  })
  return { ruleId: createdId, suggestionId }
}

// ---- Changing what is confirmed ----

const notFound = () => new AppError(404, 'not_found', 'There is nothing at this address.')
const factNotActive = () =>
  new AppError(
    409,
    'not_active',
    'This fact is no longer in force: it was replaced or retired. Change the fact that is in force instead.',
  )

async function lockActiveFact(client: PoolClient, brandId: string, factId: string): Promise<void> {
  const found = await client.query<{ status: string }>(
    'select status from app.verified_fact where brand_id = $1 and id = $2 for update',
    [brandId, factId],
  )
  if (!found.rows[0]) throw notFound()
  if (found.rows[0].status !== 'active') throw factNotActive()
}

// The new fact rests on the owner's statement of it; the old one is kept, superseded by the new one. Another fact in
// force with the new wording is refused (ruling R20); the fact's own wording is not, so its review date can move.
// The old fact leaves force before the new one is written (one fact in force per statement, index
// verified_fact_one_active), and then points at it.
export async function replaceFact(
  pool: Pool,
  deps: { audit: AuditSink },
  input: {
    brandId: string
    factId: string
    statement: string
    reviewDate: string
    actor: { userId: string }
  },
): Promise<{ factId: string }> {
  try {
    return await withBrand(pool, input.brandId, async (client) => {
      await lockOnboarding(client, input.brandId)
      await lockActiveFact(client, input.brandId, input.factId)
      await refuseActiveFactTwin(client, input.brandId, input.statement, input.factId)
      const statementId = await ownerStatement(client, input.brandId, input.statement, input.actor.userId)
      await client.query(
        `update app.verified_fact set status = 'superseded' where brand_id = $1 and id = $2`,
        [input.brandId, input.factId],
      )
      const made = await client.query<{ id: string }>(
        `insert into app.verified_fact (brand_id, statement, fact_hash, source_ids, confirmed_by, review_date)
         values ($1, $2, $3, $4::uuid[], $5, $6) returning id`,
        [
          input.brandId,
          input.statement,
          factHash(input.statement),
          [statementId],
          input.actor.userId,
          input.reviewDate,
        ],
      )
      const newFactId = made.rows[0]!.id
      await client.query('update app.verified_fact set superseded_by = $3 where brand_id = $1 and id = $2', [
        input.brandId,
        input.factId,
        newFactId,
      ])
      await deps.audit.record(
        {
          action: 'onboarding.fact_changed',
          actor: input.actor.userId,
          brandId: input.brandId,
          subject: input.factId,
          outcome: 'success',
          detail: { factId: input.factId, newFactId, change: 'replaced' },
        },
        client,
      )
      return { factId: newFactId }
    })
  } catch (error) {
    throw confirmedTwin(error)
  }
}

// A retired fact is kept, marked expired; nothing may cite it from then on.
export async function retireFact(
  pool: Pool,
  deps: { audit: AuditSink },
  input: { brandId: string; factId: string; actor: { userId: string } },
): Promise<{ factId: string }> {
  return withBrand(pool, input.brandId, async (client) => {
    await lockOnboarding(client, input.brandId)
    await lockActiveFact(client, input.brandId, input.factId)
    await client.query(`update app.verified_fact set status = 'expired' where brand_id = $1 and id = $2`, [
      input.brandId,
      input.factId,
    ])
    await deps.audit.record(
      {
        action: 'onboarding.fact_changed',
        actor: input.actor.userId,
        brandId: input.brandId,
        subject: input.factId,
        outcome: 'success',
        detail: { factId: input.factId, change: 'retired' },
      },
      client,
    )
    return { factId: input.factId }
  })
}

// A rule turned off is kept, no longer active.
export async function turnOffRule(
  pool: Pool,
  deps: { audit: AuditSink },
  input: { brandId: string; ruleId: string; actor: { userId: string } },
): Promise<{ ruleId: string }> {
  return withBrand(pool, input.brandId, async (client) => {
    await lockOnboarding(client, input.brandId)
    const found = await client.query<{ active: boolean }>(
      'select active from app.safety_rule where brand_id = $1 and id = $2 for update',
      [input.brandId, input.ruleId],
    )
    if (!found.rows[0]) throw notFound()
    if (!found.rows[0].active) throw new AppError(409, 'not_active', 'This rule is already off.')
    await client.query('update app.safety_rule set active = false where brand_id = $1 and id = $2', [
      input.brandId,
      input.ruleId,
    ])
    await deps.audit.record(
      {
        action: 'onboarding.rule_changed',
        actor: input.actor.userId,
        brandId: input.brandId,
        subject: input.ruleId,
        outcome: 'success',
        detail: { ruleId: input.ruleId, change: 'turned_off' },
      },
      client,
    )
    return { ruleId: input.ruleId }
  })
}
