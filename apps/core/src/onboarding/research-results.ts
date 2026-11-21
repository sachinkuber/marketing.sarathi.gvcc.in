import type { PoolClient } from '@mkt/db'
import {
  researchGroupResultSchema,
  researchMergeInputSchema,
  researchResultSchema,
  SOURCE_GROUPS,
  type ResearchMergeInput,
} from '@mkt/shared'
import { AppError } from '../errors.ts'
import type { ResultHandler } from '../jobs/results.ts'
import { createJob, type JobsDeps } from '../jobs/service.ts'
import { enqueueNotification } from '../notify/notifications.ts'
import { platformOwnersOf } from '../notify/recipients.ts'
import { GROUP_RESULT_TYPE, MERGE_RESULT_TYPE } from './research.ts'
import { gradeConfidence, type GradedSource } from './sources.ts'
import { readStoredExtract, storedExtract } from './stored-extract.ts'
import { addSuggestions } from './suggestions.ts'

// Kept here for the callers that import them from the results module.
export { readStoredExtract, storedExtract }

// Research results become profile suggestions (spec 5, 6, 8.2). A group job's result stores its sources; the
// last group to settle (finished, or dead) starts the merge job in the same run; the merge's result becomes the
// owner's open profile suggestions, with confidence graded here, whatever the agent claimed.

// The stored outcome of a finished group job (job_input.outcome). The onboarding overview reads it (research.ts).
interface GroupOutcome {
  group: ResearchMergeInput['groups'][number]['group']
  sources: { ref: string; id: string }[]
  findings: ResearchMergeInput['groups'][number]['findings']
}

// ---- research_group.v1 ----

const invalid = (what: string) => new AppError(422, 'result_invalid', `The result is not a valid ${what}.`)

// Checked again here (the worker's check is not trusted). A source may name only a document the job was given;
// one row per source is stored with the run's id, and the outcome maps the agent's refs to the stored ids.
export function researchGroupResultHandler(): ResultHandler {
  return async (client, ctx) => {
    const parsed = researchGroupResultSchema.safeParse(ctx.result)
    if (!parsed.success) throw invalid('research group result')
    // Ids are compared in lower case, as the database writes them (a uuid is valid in either case).
    const result = {
      ...parsed.data,
      sources: parsed.data.sources.map((s) => ({ ...s, documentId: s.documentId?.toLowerCase() ?? null })),
    }
    const job = await client.query<{ input: { group?: unknown; documentIds?: unknown } | null }>(
      'select input from app.job_input where job_id = $1',
      [ctx.jobId],
    )
    const given = job.rows[0]?.input
    if (result.group !== given?.group) throw invalid('result for this research group')
    const documents = new Set(
      (Array.isArray(given.documentIds) ? given.documentIds : []).map((id) => String(id).toLowerCase()),
    )
    if (result.sources.some((s) => s.documentId !== null && !documents.has(s.documentId))) {
      throw new AppError(
        422,
        'document_outside_job',
        'A source names a document this job was not given. Cite only the documents in the job input.',
      )
    }
    const ids = new Map<string, string>()
    for (const source of result.sources) {
      const made = await client.query<{ id: string }>(
        `insert into app.research_source (brand_id, run_id, kind, address, document_id, result, extract)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [
          ctx.brandId,
          ctx.runId,
          source.kind,
          source.address,
          source.documentId,
          source.result,
          storedExtract(source.extract, source.flagged),
        ],
      )
      ids.set(source.ref, made.rows[0]!.id)
    }
    const outcome: GroupOutcome = {
      group: result.group,
      sources: result.sources.map((source) => ({ ref: source.ref, id: ids.get(source.ref)! })),
      findings: result.findings.map((finding) => ({
        key: finding.key,
        proposed: finding.proposed,
        why: finding.why,
        sourceIds: finding.sourceRefs.map((ref) => ids.get(ref)!),
        confidence: finding.confidence,
        conflict: finding.conflict,
      })),
    }
    return outcome
  }
}

// ---- Starting the merge ----

// The settled hook of research_group.v1 (jobs/service.ts), run when a group finishes or dies. When no group of
// the run is still open (finished, dead and cancelled ones have settled) and the run has no merge job, the merge
// job is made in the same run from the finished groups' outcomes, naming the groups that could not be read.
// When no group finished there is nothing to merge: finaliseRun then ends the run failed.
// Two groups settling at once both hold their own job row and then queue for the run row, which is taken here
// before anything is read: the second waits, then sees the first's end and its merge job, so a run gets exactly
// one merge. A requeued group that finishes later finds the merge job and starts nothing.
export async function maybeStartMerge(
  client: PoolClient,
  deps: Pick<JobsDeps, 'queue' | 'backlogLimit'>,
  input: { brandId: string; runId: string },
): Promise<string | null> {
  const run = await client.query<{ state: string }>('select state from app.run where id = $1 for update', [
    input.runId,
  ])
  // A run someone cancelled, or one held or needing manual work, is not carried on.
  if (!['created', 'running', 'failed'].includes(run.rows[0]?.state ?? '')) return null
  // Nor is a run the brand's research has moved past (a requeued group of an old run): the caller's finaliseRun
  // ends it without a merge, so it never overwrites a newer run's suggestions. The row is shared-locked, so a
  // new start waits for this transaction.
  const current = await client.query<{ research_run_id: string | null }>(
    'select research_run_id from app.onboarding where brand_id = $1 for share',
    [input.brandId],
  )
  if (current.rows[0]?.research_run_id !== input.runId) return null
  const { rows } = await client.query<{
    type: string
    group: string
    outcome: GroupOutcome | null
    finished: boolean
    open: boolean
  }>(
    `select i.expected_result_type as type, i.input->>'group' as "group", i.outcome,
            i.finished_at is not null as finished,
            (i.finished_at is null and not c.cancel_requested and c.dead_at is null) as open
       from app.job_input i join app.job_control c on c.job_id = i.job_id
      where i.run_id = $1`,
    [input.runId],
  )
  if (rows.some((r) => r.type === MERGE_RESULT_TYPE)) return null
  const groups = rows.filter((r) => r.type === GROUP_RESULT_TYPE)
  if (groups.length === 0 || groups.some((r) => r.open)) return null
  const order = (group: string) => SOURCE_GROUPS.indexOf(group as (typeof SOURCE_GROUPS)[number])
  const done = groups
    .filter((r) => r.finished)
    .map((r) => r.outcome!)
    .sort((a, b) => order(a.group) - order(b.group))
  if (done.length === 0) return null

  const ids = done.flatMap((outcome) => outcome.sources.map((source) => source.id))
  const stored = await client.query<{
    id: string
    kind: string
    address: string | null
    result: string
    extract: string
  }>(
    `select id, kind, address, result, extract from app.research_source
      where brand_id = $1 and id = any($2::uuid[])`,
    [input.brandId, ids],
  )
  const byId = new Map(stored.rows.map((row) => [row.id, row]))
  const mergeInput = researchMergeInputSchema.parse({
    groups: done.map((outcome) => ({
      group: outcome.group,
      sources: outcome.sources.map(({ id }) => {
        const source = byId.get(id)!
        const { extract, flagged } = readStoredExtract(source.extract)
        return { id, kind: source.kind, address: source.address, result: source.result, extract, flagged }
      }),
      findings: outcome.findings,
    })),
    deadGroups: groups
      .filter((r) => !r.finished)
      .map((r) => r.group)
      .sort((a, b) => order(a) - order(b)),
  })
  return createJob(
    client,
    deps,
    input.brandId,
    {
      runId: input.runId,
      jobClass: 'production',
      input: mergeInput,
      expectedResultType: MERGE_RESULT_TYPE,
      agent: 'research_merge',
    },
    // The last step of a run whose groups already passed the check: refusing it would strand the run.
    { backpressure: false },
  )
}

// ---- research.v1 ----

// The merge's result, checked again here. A result for a run that is no longer the brand's research (a newer run
// started) stores nothing: its outcome says it is stale. Every source it cites must have been read in this run,
// for this brand. Each suggestion's confidence is graded from its sources and the intake website (it may only go
// down); a lowered one says why. The suggestions are added as open profile suggestions (an undecided one of an
// earlier run with the same key is superseded, a decided one is kept), the onboarding step moves to the profile,
// and every platform owner is told. The outcome is the count of suggestions and the gaps, which the draft
// profile shows.
export function researchResultHandler(deps: Pick<JobsDeps, 'audit'>): ResultHandler {
  return async (client, ctx) => {
    const parsed = researchResultSchema.safeParse(ctx.result)
    if (!parsed.success) throw invalid('research result')
    // The onboarding row is locked before anything is written, so a new research start waits for this result.
    const onboarding = await client.query<{ research_run_id: string | null; website: string | null }>(
      `select research_run_id, intake->>'website' as website from app.onboarding where brand_id = $1 for update`,
      [ctx.brandId],
    )
    if (onboarding.rows[0]?.research_run_id !== ctx.runId) return { suggestions: 0, gaps: [], stale: true }
    // Ids are compared in lower case, as the database returns them (a uuid is valid in either case).
    const result = {
      ...parsed.data,
      suggestions: parsed.data.suggestions.map((s) => ({
        ...s,
        sourceIds: [...new Set(s.sourceIds.map((id) => id.toLowerCase()))],
      })),
    }
    const cited = [...new Set(result.suggestions.flatMap((s) => s.sourceIds))]
    const found = await client.query<GradedSource & { id: string }>(
      `select id, kind, address, result from app.research_source
        where brand_id = $1 and run_id = $2 and id = any($3::uuid[])`,
      [ctx.brandId, ctx.runId, cited],
    )
    if (found.rows.length !== cited.length) {
      throw new AppError(
        422,
        'source_outside_run',
        'A suggestion cites a source that was not read in this research run. Cite only the sources the merge was given.',
      )
    }
    const sources = new Map(found.rows.map((row) => [row.id, row]))

    // The keys whose findings disagreed in some group (the merge job's own input).
    const job = await client.query<{ input: Partial<ResearchMergeInput> | null }>(
      'select input from app.job_input where job_id = $1',
      [ctx.jobId],
    )
    const conflicts = new Set(
      (job.rows[0]?.input?.groups ?? []).flatMap((g) =>
        g.findings.filter((f) => f.conflict).map((f) => f.key),
      ),
    )
    // The website the run researched (its group jobs' intake), else the intake saved now (ruling R33).
    const researched = await client.query<{ website: string | null }>(
      `select input->'intake'->>'website' as website from app.job_input
        where run_id = $1 and expected_result_type = $2 and input->'intake'->>'website' is not null limit 1`,
      [ctx.runId, GROUP_RESULT_TYPE],
    )
    const website = researched.rows[0]?.website ?? onboarding.rows[0]?.website ?? null

    const items = result.suggestions.map((suggestion) => {
      const grade = gradeConfidence(
        suggestion.sourceIds.map((id) => sources.get(id)!),
        suggestion.confidence,
        {
          key: suggestion.key,
          disagree: conflicts.has(suggestion.key) || /sources disagree/i.test(suggestion.why),
          website,
        },
      )
      const note = grade.note === undefined ? '' : ` (${grade.note})`
      return {
        step: 'profile' as const,
        key: suggestion.key,
        proposed: suggestion.proposed,
        why: note === '' || suggestion.why.endsWith(note) ? suggestion.why : `${suggestion.why}${note}`,
        sourceIds: suggestion.sourceIds,
        confidence: grade.confidence,
        ...(suggestion.options === undefined ? {} : { options: suggestion.options }),
      }
    })
    await addSuggestions(client, deps, { brandId: ctx.brandId, runId: ctx.runId, items })
    await client.query(
      `update app.onboarding set step = 'profile' where brand_id = $1 and research_run_id = $2`,
      [ctx.brandId, ctx.runId],
    )
    for (const userId of await platformOwnersOf(client)) {
      await enqueueNotification(client, {
        brandId: ctx.brandId,
        userId,
        kind: 'research_done',
        subject: { kind: 'run', id: ctx.runId },
      })
    }
    return { suggestions: items.length, gaps: result.gaps }
  }
}
