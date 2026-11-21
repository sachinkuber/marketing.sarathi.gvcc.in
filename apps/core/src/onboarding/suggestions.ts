import { createHash } from 'node:crypto'
import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import { RESEARCH_SOURCE_KINDS, SAFETY_RULE_KINDS } from '@mkt/shared'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'
import { readStoredExtract } from './stored-extract.ts'
import { qualifiesAsFactSource, type SourceKind } from './sources.ts'

// The kinds whose stored extract research wrote (with its flag marker and cut); an owner statement is not one.
const RESEARCH_KINDS: readonly string[] = RESEARCH_SOURCE_KINDS

export type SuggestionStep = 'profile' | 'question' | 'fact' | 'rule' | 'choice'
export type Confidence = 'found' | 'assumed' | 'unknown'
export type Decision = 'accepted' | 'edited' | 'rejected'

export type SuggestionInput = {
  step: SuggestionStep
  key: string
  proposed: unknown
  why: string
  sourceIds: string[]
  confidence: Confidence
  options?: { value: unknown; tradeOff: string; recommended: boolean }[]
}

interface Deps {
  audit: AuditSink
}

// Stores new suggestions. A re-run replaces what it found before: an undecided suggestion with the same brand,
// step and key is marked superseded by the new one; a decided one is never touched.
export async function addSuggestions(
  client: PoolClient,
  deps: Deps,
  input: { brandId: string; runId: string | null; items: SuggestionInput[] },
): Promise<string[]> {
  const wanted = [...new Set(input.items.flatMap((i) => i.sourceIds))]
  if (wanted.length > 0) {
    const known = await client.query<{ n: number }>(
      `select count(*)::int as n from app.research_source where brand_id = $1 and id = any($2::uuid[])`,
      [input.brandId, wanted],
    )
    const missing = wanted.length - (known.rows[0]?.n ?? 0)
    if (missing > 0)
      throw new AppError(
        422,
        'unknown_source',
        `${missing} source id(s) do not belong to this brand's research sources. Use only ids of sources read for this brand.`,
      )
  }
  const ids: string[] = []
  for (const item of input.items) ids.push(await insertSuggestion(client, input.brandId, input.runId, item))
  await deps.audit.record(
    {
      action: 'onboarding.suggestions_added',
      actor: null,
      actorKind: 'system',
      brandId: input.brandId,
      subject: input.runId,
      outcome: 'success',
      detail: { runId: input.runId, count: ids.length },
    },
    client,
  )
  return ids
}

// One suggestion, which supersedes the undecided suggestion of the same brand, step and key; a decided one is
// never touched. Its sources are the caller's to check.
export async function insertSuggestion(
  client: PoolClient,
  brandId: string,
  runId: string | null,
  item: SuggestionInput,
): Promise<string> {
  const made = await client.query<{ id: string }>(
    `insert into app.suggestion (brand_id, run_id, step, key, proposed, why, source_ids, confidence, options)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7::uuid[], $8, $9::jsonb) returning id`,
    [
      brandId,
      runId,
      item.step,
      item.key,
      JSON.stringify(item.proposed),
      item.why,
      item.sourceIds,
      item.confidence,
      item.options === undefined ? null : JSON.stringify(item.options),
    ],
  )
  const id = made.rows[0]!.id
  await client.query(
    `update app.suggestion set superseded_by = $4
      where brand_id = $1 and step = $2 and key = $3 and id <> $4
        and decision is null and superseded_by is null`,
    [brandId, item.step, item.key, id],
  )
  return id
}

interface SuggestionRow {
  id: string
  step: SuggestionStep
  key: string
  proposed: unknown
  why: string
  source_ids: string[]
  confidence: Confidence
  decision: Decision | null
  superseded_by: string | null
}

const SAFETY_KINDS: readonly string[] = SAFETY_RULE_KINDS

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const invalid = (message: string) => new AppError(422, 'invalid_value', message)

// A statement or rule text arrives as plain text, or as an object with that text in a named field.
function textOf(value: unknown, field: string): string | null {
  const raw = typeof value === 'string' ? value : isObject(value) ? value[field] : undefined
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
}

const normalise = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
// A verified fact's hash: the sha256 of its normalised statement, so the same fact in other spacing or case matches.
export const factHash = (statement: string) => createHash('sha256').update(normalise(statement)).digest('hex')

// Ruling R10: the profile holds one current item per key; a new one supersedes it in this transaction. The
// current item is locked first, so a write on the same key elsewhere waits, then supersedes this one.
export async function supersedeProfileItem(
  client: PoolClient,
  input: {
    brandId: string
    key: string
    value: unknown
    status: Confidence
    sourceIds: string[]
    fromSuggestion: string | null
  },
): Promise<string> {
  await client.query(
    `select id from app.profile_item where brand_id = $1 and key = $2 and superseded_by is null for update`,
    [input.brandId, input.key],
  )
  const made = await client.query<{ id: string }>(
    `insert into app.profile_item (brand_id, key, value, status, source_ids, from_suggestion)
     values ($1, $2, $3::jsonb, $4, $5::uuid[], $6) returning id`,
    [
      input.brandId,
      input.key,
      JSON.stringify(input.value),
      input.status,
      input.sourceIds,
      input.fromSuggestion,
    ],
  )
  const id = made.rows[0]!.id
  await client.query(
    `update app.profile_item set superseded_by = $3
      where brand_id = $1 and key = $2 and superseded_by is null and id <> $3`,
    [input.brandId, input.key, id],
  )
  return id
}

// One decision inside the caller's transaction. `ownAddition` marks a suggestion the owner wrote and accepted in
// the same action (facts and rules, "add your own", ruling R2): its audit entry says so.
export async function decideWithin(
  client: PoolClient,
  deps: Deps,
  input: {
    brandId: string
    suggestionId: string
    decision: Decision
    value?: unknown
    reason?: string
    actor: { userId: string }
    ownAddition?: boolean
  },
): Promise<{ createdId: string | null }> {
  if (input.value !== undefined && input.decision !== 'edited')
    throw new AppError(400, 'invalid_request', 'The request is not valid.', [
      { part: 'body', path: 'value', message: 'value is only used with "edited"' },
    ])
  const found = await client.query<SuggestionRow>(
    `select id, step, key, proposed, why, source_ids, confidence, decision, superseded_by
       from app.suggestion where brand_id = $1 and id = $2 for update`,
    [input.brandId, input.suggestionId],
  )
  const row = found.rows[0]
  if (!row) throw new AppError(404, 'not_found', 'There is nothing at this address.')
  if (row.decision)
    throw new AppError(409, 'already_decided', 'This suggestion already has a decision. Decide a newer one.')
  if (row.superseded_by)
    throw new AppError(409, 'superseded', 'A newer run replaced this suggestion. Decide the newer one.')

  const accepted = input.decision !== 'rejected'
  const chosen = input.decision === 'edited' ? input.value : row.proposed
  let createdId: string | null = null

  if (accepted && row.step === 'profile') {
    createdId = await supersedeProfileItem(client, {
      brandId: input.brandId,
      key: row.key,
      value: chosen,
      status: row.confidence,
      sourceIds: row.source_ids,
      fromSuggestion: row.id,
    })
  } else if (accepted && row.step === 'fact') {
    createdId = await writeFact(client, input, row, chosen)
  } else if (accepted && row.step === 'rule') {
    createdId = await writeRule(client, input, row, chosen)
  }

  const decidedValue = input.decision === 'edited' ? input.value : null
  await client.query(
    `update app.suggestion
        set decision = $3, decided_value = $4::jsonb, decided_reason = $5, decided_by = $6, decided_at = now()
      where brand_id = $1 and id = $2`,
    [
      input.brandId,
      row.id,
      input.decision,
      decidedValue === null || decidedValue === undefined ? null : JSON.stringify(decidedValue),
      input.reason?.trim() ? input.reason : null,
      input.actor.userId,
    ],
  )
  await deps.audit.record(
    {
      action: 'onboarding.suggestion_decided',
      actor: input.actor.userId,
      subject: row.id,
      brandId: input.brandId,
      outcome: 'success',
      detail: {
        suggestionId: row.id,
        step: row.step,
        decision: input.decision,
        ...(input.ownAddition ? { ownAddition: true } : {}),
      },
    },
    client,
  )
  return { createdId }
}

async function writeFact(
  client: PoolClient,
  input: { brandId: string; decision: Decision; actor: { userId: string } },
  row: SuggestionRow,
  chosen: unknown,
): Promise<string> {
  const statement = textOf(chosen, 'statement')
  if (!statement) throw invalid('Give the fact as a statement, in plain text.')
  const proposedDate = isObject(row.proposed) ? row.proposed.reviewDate : undefined
  const given = isObject(chosen) && chosen.reviewDate !== undefined ? chosen.reviewDate : proposedDate
  // Round-tripping rejects a date the calendar does not have, such as 2026-02-30.
  const realDate = (value: string): boolean => {
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }
  if (typeof given !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(given) || !realDate(given))
    throw new AppError(
      422,
      'review_date_needed',
      'This fact needs a review date. Give one as reviewDate in the form YYYY-MM-DD.',
    )

  const kinds = row.source_ids.length
    ? (
        await client.query<{ kind: SourceKind }>(
          `select kind from app.research_source where brand_id = $1 and id = any($2::uuid[])`,
          [input.brandId, row.source_ids],
        )
      ).rows.map((r) => r.kind)
    : []
  // Only the owner's own wording can turn a weak source into a fact. Accepting as found does not.
  if (input.decision !== 'edited' && !qualifiesAsFactSource(kinds))
    throw new AppError(
      422,
      'fact_needs_source',
      'A fact needs a source from the brand site or an uploaded document. Edit it to state it in your own words, or reject it.',
    )

  const sourceIds = [...row.source_ids]
  if (input.decision === 'edited') {
    const added = await client.query<{ id: string }>(
      `insert into app.research_source (brand_id, kind, result, extract, stated_by)
       values ($1, 'owner_statement', 'stated', $2, $3) returning id`,
      [input.brandId, statement, input.actor.userId],
    )
    sourceIds.push(added.rows[0]!.id)
  }
  const made = await client.query<{ id: string }>(
    `insert into app.verified_fact
       (brand_id, statement, fact_hash, source_ids, confirmed_by, review_date, from_suggestion)
     values ($1, $2, $3, $4::uuid[], $5, $6, $7) returning id`,
    [input.brandId, statement, factHash(statement), sourceIds, input.actor.userId, given, row.id],
  )
  return made.rows[0]!.id
}

async function writeRule(
  client: PoolClient,
  input: { brandId: string; actor: { userId: string } },
  row: SuggestionRow,
  chosen: unknown,
): Promise<string> {
  const text = textOf(chosen, 'text')
  if (!text) throw invalid('Give the rule as text, in plain words.')
  const base = isObject(row.proposed) ? row.proposed : {}
  const kind = isObject(chosen) && chosen.kind !== undefined ? chosen.kind : base.kind
  if (typeof kind !== 'string' || !SAFETY_KINDS.includes(kind))
    throw invalid(`The rule needs a kind: one of ${SAFETY_KINDS.join(', ')}.`)
  const why = isObject(chosen) && typeof chosen.why === 'string' ? chosen.why : row.why
  const made = await client.query<{ id: string }>(
    `insert into app.safety_rule (brand_id, kind, text, why, confirmed_by, from_suggestion)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [input.brandId, kind, text, why, input.actor.userId, row.id],
  )
  return made.rows[0]!.id
}

export async function decideSuggestion(
  pool: Pool,
  deps: Deps,
  input: {
    brandId: string
    suggestionId: string
    decision: Decision
    value?: unknown
    reason?: string
    actor: { userId: string }
  },
): Promise<{ createdId: string | null }> {
  return withBrand(pool, input.brandId, (client) => decideWithin(client, deps, input))
}

// Accepts every open suggestion of a step that the agent marked found. Assumed and unknown ones stay open for
// the owner. A fact whose sources cannot support it is left open too: it needs an edit, not a bulk accept.
export async function acceptFound(
  pool: Pool,
  deps: Deps,
  input: { brandId: string; step: SuggestionStep; actor: { userId: string } },
): Promise<{ accepted: number }> {
  return withBrand(pool, input.brandId, async (client) => {
    const open = await client.query<{ id: string }>(
      `select id from app.suggestion
        where brand_id = $1 and step = $2 and confidence = 'found'
          and decision is null and superseded_by is null
        order by created_at, id
        for update skip locked`,
      [input.brandId, input.step],
    )
    let accepted = 0
    for (const { id } of open.rows) {
      try {
        await decideWithin(client, deps, {
          brandId: input.brandId,
          suggestionId: id,
          decision: 'accepted',
          actor: input.actor,
        })
        accepted += 1
      } catch (err) {
        // Refusals happen before anything is written, so the transaction is still clean. A 409 means someone
        // else decided or replaced the row meanwhile: skip it.
        if (!(err instanceof AppError) || (err.status !== 422 && err.status !== 409)) throw err
      }
    }
    return { accepted }
  })
}

// A source as the owner reads it: the stored flag marker and escape are taken off the extract, the flag kept apart.
export interface SourceView {
  id: string
  kind: SourceKind
  address: string | null
  readAt: string
  extract: string
  flagged: { reason: string } | null
}

export interface SuggestionView {
  id: string
  step: SuggestionStep
  key: string
  proposed: unknown
  why: string
  confidence: Confidence
  options: unknown
  decision: Decision | null
  decidedValue: unknown
  decidedReason: string | null
  decidedAt: string | null
  createdAt: string
  sources: SourceView[]
}

// The sources whose ids are in the array column `ids` of a row aliased with `brand_id`, as a JSON list in the order
// they were read, for sourceViews below.
export const sourcesJson = (row: string, ids: string) =>
  `coalesce((select json_agg(json_build_object('id', r.id, 'kind', r.kind, 'address', r.address,
                                             'readAt', r.read_at, 'extract', r.extract)
                      order by r.read_at, r.id)
              from app.research_source r
             where r.brand_id = ${row}.brand_id and r.id = any(${row}.${ids})), '[]'::json)`

export function sourceViews(sources: unknown): SourceView[] {
  return (
    sources as {
      id: string
      kind: SourceKind
      address: string | null
      readAt: string
      extract: string
    }[]
  ).map((source) => ({
    ...source,
    readAt: new Date(source.readAt).toISOString(),
    // Only research extracts carry the stored flag marker and the 500-character cut. An owner statement is
    // the owner's own words, returned exactly as stated and never read as flagged.
    ...(RESEARCH_KINDS.includes(source.kind)
      ? readStoredExtract(source.extract)
      : { extract: source.extract, flagged: null }),
  }))
}

export async function listSuggestions(
  pool: Pool,
  brandId: string,
  step?: SuggestionStep,
): Promise<SuggestionView[]> {
  return withBrand(pool, brandId, (client) => listSuggestionsWithin(client, brandId, step))
}

// The suggestions not replaced, open and decided, newest first, with their sources.
export async function listSuggestionsWithin(
  client: PoolClient,
  brandId: string,
  step?: SuggestionStep,
): Promise<SuggestionView[]> {
  const found = await client.query(
    `select s.id, s.step, s.key, s.proposed, s.why, s.confidence, s.options, s.decision, s.decided_value,
            s.decided_reason, s.decided_at, s.created_at, ${sourcesJson('s', 'source_ids')} as sources
       from app.suggestion s
      where s.brand_id = $1 and s.superseded_by is null and ($2::app.suggestion_step is null or s.step = $2)
      order by s.created_at desc, s.id`,
    [brandId, step ?? null],
  )
  return found.rows.map((r) => ({
    id: r.id,
    step: r.step,
    key: r.key,
    proposed: r.proposed,
    why: r.why,
    confidence: r.confidence,
    options: r.options,
    decision: r.decision,
    decidedValue: r.decided_value,
    decidedReason: r.decided_reason,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    sources: sourceViews(r.sources),
  }))
}
