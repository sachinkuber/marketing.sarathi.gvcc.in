import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import { CLASS_SETTINGS, type JobClass, type Queue } from '@mkt/queue'
import { createHash, randomUUID } from 'node:crypto'
import type { AuditSink } from '../ports.ts'
import { AppError } from '../errors.ts'
import type { ResultHandlers } from './results.ts'
import { inrMicros, usdMicros } from './money.ts'
import { signAttemptToken, type AttemptClaims } from './token.ts'

export interface JobsDeps {
  pool: Pool
  queue: Queue
  audit: AuditSink
  workerSecret: string
  attemptTokenSecret: string
  backlogLimit: number
  now: () => Date
  results: ResultHandlers
}

export interface NewRun {
  agent: string
  definitionVersionId: string
  startedByKind: 'user' | 'agent' | 'system' | 'n8n'
  startedById: string | null
}

export async function createRun(client: PoolClient, brandId: string, run: NewRun): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into app.run (brand_id, agent, definition_version_id, state, started_by_kind, started_by_id)
     values ($1, $2, $3, 'running', $4, $5) returning id`,
    [brandId, run.agent, run.definitionVersionId, run.startedByKind, run.startedById],
  )
  return rows[0]!.id
}

export interface NewJob {
  runId: string
  jobClass: JobClass
  input: unknown
  expectedResultType: string
}

// Backpressure applies to production and bulk work only (architecture 7.1): interactive and publishing
// work is never refused for a backlog.
const BACKPRESSURE: ReadonlySet<JobClass> = new Set(['production', 'bulk'])

// Runs inside the caller's withBrand transaction, so the job exists if and only if the business change does.
export async function createJob(
  client: PoolClient,
  deps: Pick<JobsDeps, 'queue' | 'backlogLimit'>,
  brandId: string,
  job: NewJob,
): Promise<string> {
  if (BACKPRESSURE.has(job.jobClass) && (await deps.queue.depth(job.jobClass)) >= deps.backlogLimit) {
    throw new AppError(503, 'queue_busy', 'Too much work is waiting. Try again shortly.')
  }
  const brand = await client.query<{ schedule_key: string }>(
    'select schedule_key from app.brand where id = $1',
    [brandId],
  )
  const scheduleKey = brand.rows[0]?.schedule_key
  if (!scheduleKey) throw new AppError(404, 'brand_not_found', 'No such brand.')
  const jobId = randomUUID()
  await client.query(
    `insert into app.job_input (job_id, brand_id, run_id, class, input, expected_result_type)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [jobId, brandId, job.runId, job.jobClass, JSON.stringify(job.input), job.expectedResultType],
  )
  await client.query('insert into app.job_control (job_id, brand_id) values ($1, $2)', [jobId, brandId])
  await deps.queue.send(client, { jobId, jobClass: job.jobClass, scheduleKey })
  return jobId
}

export interface StartedAttempt {
  finished: false
  attemptId: string
  attemptNumber: number
  token: string
  input: unknown
  savedSteps: unknown[]
  expectedResultType: string
  jobClass: JobClass
}
export interface FinishedJob {
  finished: true
  outcome: unknown
}

export async function startAttempt(
  deps: JobsDeps,
  jobId: string,
  workerId: string,
): Promise<StartedAttempt | FinishedJob> {
  const found = await deps.pool.query<{ brand: string | null }>('select app.job_brand($1) as brand', [jobId])
  const brandId = found.rows[0]?.brand
  if (!brandId) throw new AppError(404, 'job_not_found', 'No such job.')

  return withBrand(deps.pool, brandId, async (client) => {
    const job = await client.query<{
      class: JobClass
      run_id: string
      input: unknown
      saved_steps: unknown[]
      expected_result_type: string
      outcome: unknown
      finished_at: Date | null
    }>(
      `select class, run_id, input, saved_steps, expected_result_type, outcome, finished_at
         from app.job_input where job_id = $1 for update`,
      [jobId],
    )
    const row = job.rows[0]
    if (!row) throw new AppError(404, 'job_not_found', 'No such job.')
    // A job already finished (the worker crashed after the core accepted the result): tell it so, and the
    // worker completes the queue row. No new attempt.
    if (row.finished_at) return { finished: true as const, outcome: row.outcome }

    // The queue's own record, not the worker's word: the job must be active.
    if ((await deps.queue.state(row.class, jobId)) !== 'active') {
      throw new AppError(409, 'job_not_active', 'The queue does not show this job as claimed.')
    }

    await client.query(
      `update app.job_attempt set state = 'superseded', ended_at = now() where job_id = $1 and state = 'active'`,
      [jobId],
    )
    const next = await client.query<{ n: number }>(
      'select coalesce(max(attempt_number), 0) + 1 as n from app.job_attempt where job_id = $1',
      [jobId],
    )
    const attemptNumber = Number(next.rows[0]!.n)
    const tokenId = randomUUID()
    const created = await client.query<{ id: string }>(
      `insert into app.job_attempt (brand_id, job_id, attempt_number, worker_id, token_id)
       values ($1, $2, $3, $4, $5) returning id`,
      [brandId, jobId, attemptNumber, workerId, tokenId],
    )
    const attemptId = created.rows[0]!.id
    // A requeued job is no longer dead, and its run (failed when the job was marked dead) runs again. This
    // is what makes a requeue whose database half rolled back still end right. The job_input lock is held;
    // the run row is taken next, the engine's lock order.
    await client.query('update app.job_control set dead_at = null, updated_at = now() where job_id = $1', [
      jobId,
    ])
    await client.query('select 1 from app.run where id = $1 for update', [row.run_id])
    await client.query(
      `update app.run set state = 'running', finished_at = null where id = $1 and state = 'failed'`,
      [row.run_id],
    )

    const issuedAt = Math.floor(deps.now().getTime() / 1000)
    const claims: AttemptClaims = {
      tokenId,
      jobId,
      brandId,
      attemptId,
      resultType: row.expected_result_type,
      issuedAt,
      expiresAt: issuedAt + CLASS_SETTINGS[row.class].expireInSeconds,
    }
    return {
      finished: false as const,
      attemptId,
      attemptNumber,
      token: signAttemptToken(deps.attemptTokenSecret, claims),
      input: row.input,
      savedSteps: row.saved_steps,
      expectedResultType: row.expected_result_type,
      jobClass: row.class,
    }
  })
}

// The attempt in the token must be the job's current one: the latest, and still active (or already
// succeeded, so a repeated result post gets its first outcome back). Anything else is refused and recorded.
//
// Callers must call this first inside the transaction that then writes. It takes the job's row lock (the
// same lock startAttempt holds while it supersedes), so a supersede cannot commit between this check and
// the caller's write: it waits until the caller's transaction ends, and the old attempt is refused after.
export async function requireCurrentAttempt(
  client: PoolClient,
  deps: JobsDeps,
  claims: AttemptClaims,
): Promise<void> {
  await client.query('select 1 from app.job_input where job_id = $1 for update', [claims.jobId])
  const { rows } = await client.query<{ id: string; state: string }>(
    `select id, state from app.job_attempt where job_id = $1 order by attempt_number desc limit 1`,
    [claims.jobId],
  )
  const latest = rows[0]
  const current =
    latest?.id === claims.attemptId && (latest.state === 'active' || latest.state === 'succeeded')
  if (current) return
  const reason = latest?.id === claims.attemptId ? 'attempt_ended' : 'attempt_superseded'
  await deps.audit.record({
    action: 'worker.attempt_refused',
    actor: null,
    brandId: claims.brandId,
    subject: claims.jobId,
    outcome: 'failure',
    detail: { reason, jobId: claims.jobId, attemptId: claims.attemptId },
  })
  throw new AppError(403, 'attempt_refused', 'This attempt may not do that.')
}

export async function readControl(
  client: PoolClient,
  jobId: string,
): Promise<{ cancelRequested: boolean; held: boolean }> {
  const { rows } = await client.query<{ cancel_requested: boolean; held: boolean }>(
    'select cancel_requested, held from app.job_control where job_id = $1',
    [jobId],
  )
  const row = rows[0]
  return { cancelRequested: row?.cancel_requested ?? false, held: row?.held ?? false }
}

export interface RegisterInput {
  step: string
  requestHash: string
  model: string
}
export type Registered =
  | { outcome: 'send'; callId: string; possibleDuplicate: boolean }
  | { outcome: 'use_checkpoint'; output: unknown }
  | { outcome: 'cancelled' }
  | { outcome: 'held' }

interface SavedStep {
  step: string
  requestHash: string
  output: unknown
  callId: string
}

// Spec 9.5, steps 1 to 3. The row exists before the request is sent.
export async function registerModelCall(
  deps: JobsDeps,
  claims: AttemptClaims,
  input: RegisterInput,
): Promise<Registered> {
  return withBrand(deps.pool, claims.brandId, async (client) => {
    await requireCurrentAttempt(client, deps, claims)
    const job = await client.query<{ saved_steps: SavedStep[]; run_id: string }>(
      'select saved_steps, run_id from app.job_input where job_id = $1 for update',
      [claims.jobId],
    )
    const saved = job.rows[0]!.saved_steps.find(
      (s) => s.step === input.step && s.requestHash === input.requestHash,
    )
    if (saved) return { outcome: 'use_checkpoint' as const, output: saved.output }

    // The core hands the cancel and held flags back before every model call (spec 9.2).
    const control = await readControl(client, claims.jobId)
    if (control.cancelRequested) return { outcome: 'cancelled' as const }
    if (control.held) return { outcome: 'held' as const }

    // A call with no recorded outcome may still have been answered: 'started', or 'unknown' once the sweep
    // has moved it. A 'failed' one is a request the provider is known to have refused, so a retry of it is
    // not a duplicate.
    const earlier = await client.query(
      `select 1 from app.model_call
        where job_id = $1 and step = $2 and request_hash = $3 and status in ('started', 'unknown') limit 1`,
      [claims.jobId, input.step, input.requestHash],
    )
    const possibleDuplicate = (earlier.rowCount ?? 0) > 0
    const created = await client.query<{ id: string }>(
      `insert into app.model_call (brand_id, run_id, job_id, attempt_id, step, request_hash, model, possible_duplicate)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        claims.brandId,
        job.rows[0]!.run_id,
        claims.jobId,
        claims.attemptId,
        input.step,
        input.requestHash,
        input.model,
        possibleDuplicate,
      ],
    )
    return { outcome: 'send' as const, callId: created.rows[0]!.id, possibleDuplicate }
  })
}

export interface CheckpointInput {
  callId: string
  step: string
  output: unknown
  model: string
  providerMessageId: string
  providerRequestId: string | null
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
}

// Spec 9.5, step 4: in one transaction the core saves the step, marks the call succeeded, stores the
// provider's IDs and token counts, and writes the cost. A missing price or rate never blocks it (decisions 5, 6).
export async function saveCheckpoint(
  deps: JobsDeps,
  claims: AttemptClaims,
  input: CheckpointInput,
): Promise<{ costed: boolean }> {
  return withBrand(deps.pool, claims.brandId, async (client) => {
    await requireCurrentAttempt(client, deps, claims)
    const job = await client.query<{ saved_steps: SavedStep[]; run_id: string }>(
      'select saved_steps, run_id from app.job_input where job_id = $1 for update',
      [claims.jobId],
    )
    const call = await client.query<{
      status: string
      step: string
      model: string
      request_hash: string
      attempt_id: string
    }>(
      'select status, step, model, request_hash, attempt_id from app.model_call where id = $1 and job_id = $2',
      [input.callId, claims.jobId],
    )
    const row = call.rows[0]
    if (!row) throw new AppError(404, 'call_not_found', 'No such model call.')
    if (row.attempt_id !== claims.attemptId) {
      throw new AppError(403, 'attempt_refused', 'This attempt may not do that.')
    }
    if (row.step !== input.step) {
      throw new AppError(400, 'invalid_request', 'The step is not the one this call was registered for.')
    }
    if (row.model !== input.model) {
      throw new AppError(400, 'invalid_request', 'The model is not the one this call was registered for.')
    }
    // Saving twice keeps the first output and cost: a repeat only reports whether the call was costed.
    if (row.status === 'succeeded') {
      const costed = await client.query('select 1 from app.cost_ledger where model_call_id = $1', [
        input.callId,
      ])
      return { costed: (costed.rowCount ?? 0) > 0 }
    }

    // 'started' and 'unknown' (moved by the sweep; the answer arrived late) may be saved; a request
    // recorded as failed may not.
    if (row.status === 'failed') {
      throw new AppError(409, 'call_failed', 'This model call was recorded as failed.')
    }

    const today = deps.now().toISOString().slice(0, 10)
    const price = await client.query<{
      input_micros: string
      output_micros: string
      cache_read_micros: string
      cache_write_micros: string
    }>(
      `select input_micros, output_micros, cache_read_micros, cache_write_micros from app.model_price
        where model = $1 and effective_from <= $2::date order by effective_from desc limit 1`,
      [input.model, today],
    )
    const rate = await client.query<{ id: string; rate_micros: string }>(
      `select id, rate_micros from app.fx_rate
        where base_currency = 'USD' and quote_currency = 'INR' and rate_date <= $1::date
        order by rate_date desc limit 1`,
      [today],
    )
    const p = price.rows[0]
    const r = rate.rows[0]
    const costed = Boolean(p && r)
    const usd = p
      ? usdMicros(
          {
            inputMicros: BigInt(p.input_micros),
            outputMicros: BigInt(p.output_micros),
            cacheReadMicros: BigInt(p.cache_read_micros),
            cacheWriteMicros: BigInt(p.cache_write_micros),
          },
          input.usage,
        )
      : null
    const inr = usd !== null && r ? inrMicros(usd, BigInt(r.rate_micros)) : null

    await client.query(
      `update app.model_call set status = 'succeeded', finished_at = now(),
              provider_message_id = $2, provider_request_id = $3,
              input_tokens = $4, output_tokens = $5, cache_read_tokens = $6, cache_write_tokens = $7,
              charged_micros = $8, charged_currency = $9, usd_micros = $10, inr_micros = $11, fx_rate_id = $12
        where id = $1`,
      [
        input.callId,
        input.providerMessageId,
        input.providerRequestId,
        input.usage.inputTokens,
        input.usage.outputTokens,
        input.usage.cacheReadTokens,
        input.usage.cacheWriteTokens,
        costed ? usd!.toString() : null,
        costed ? 'USD' : null,
        costed ? usd!.toString() : null,
        costed ? inr!.toString() : null,
        costed ? r!.id : null,
      ],
    )
    if (costed) {
      const run = await client.query<{ agent: string }>('select agent from app.run where id = $1', [
        job.rows[0]!.run_id,
      ])
      await client.query(
        `insert into app.cost_ledger (brand_id, run_id, agent, model_call_id, charged_micros, charged_currency, usd_micros, inr_micros, fx_rate_id)
         values ($1, $2, $3, $4, $5, 'USD', $5, $6, $7)`,
        [
          claims.brandId,
          job.rows[0]!.run_id,
          run.rows[0]!.agent,
          input.callId,
          usd!.toString(),
          inr!.toString(),
          r!.id,
        ],
      )
    }
    const steps: SavedStep[] = [
      ...job.rows[0]!.saved_steps.filter((s) => !(s.step === row.step && s.requestHash === row.request_hash)),
      { step: row.step, requestHash: row.request_hash, output: input.output, callId: input.callId },
    ]
    await client.query('update app.job_input set saved_steps = $2::jsonb where job_id = $1', [
      claims.jobId,
      JSON.stringify(steps),
    ])
    return { costed }
  })
}

export async function failModelCall(
  deps: JobsDeps,
  claims: AttemptClaims,
  callId: string,
  error: string,
): Promise<void> {
  await withBrand(deps.pool, claims.brandId, async (client) => {
    await requireCurrentAttempt(client, deps, claims)
    await client.query(
      `update app.model_call set status = 'failed', error = $3, finished_at = now()
        where id = $1 and job_id = $2 and status = 'started'`,
      [callId, claims.jobId, error.slice(0, 2000)],
    )
  })
}

export interface PostedResult {
  type: string
  result: unknown
}
export type ResultAnswer =
  { status: 'applied'; outcome: unknown } | { status: 'repeated'; outcome: unknown } | { status: 'held' }

// JSON with object keys sorted at every depth, so two results that differ only in key order hash the same.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export const resultHash = (posted: PostedResult): string =>
  `sha256:${createHash('sha256')
    .update(canonicalJson({ type: posted.type, result: posted.result }))
    .digest('hex')}`

// Spec 9.4. One transaction: the result, its business effect, the job's end and the run's state commit
// together, or none do. The job row is locked so two posts cannot both apply.
export async function postResult(
  deps: JobsDeps,
  claims: AttemptClaims,
  posted: PostedResult,
): Promise<ResultAnswer> {
  return withBrand(deps.pool, claims.brandId, async (client) => {
    await requireCurrentAttempt(client, deps, claims)
    const found = await client.query<{
      run_id: string
      expected_result_type: string
      result_hash: string | null
      outcome: unknown
      finished_at: Date | null
    }>(
      `select run_id, expected_result_type, result_hash, outcome, finished_at
         from app.job_input where job_id = $1 for update`,
      [claims.jobId],
    )
    const job = found.rows[0]!
    const hash = resultHash(posted)

    if (job.finished_at) {
      if (job.result_hash === hash) return { status: 'repeated' as const, outcome: job.outcome }
      throw new AppError(409, 'result_differs', 'This job already has a different result.')
    }
    if (posted.type !== job.expected_result_type || posted.type !== claims.resultType) {
      throw new AppError(422, 'wrong_result_type', 'This job may not post a result of that type.')
    }
    const control = await readControl(client, claims.jobId)
    if (control.cancelRequested) throw new AppError(409, 'job_cancelled', 'This job was cancelled.')
    if (control.held) {
      // Kept, not applied: no content version, no further job, no notification until release (spec 9.4).
      await client.query('update app.job_input set held_result = $2::jsonb where job_id = $1', [
        claims.jobId,
        JSON.stringify(posted),
      ])
      return { status: 'held' as const }
    }
    const handler = deps.results.get(posted.type)
    if (!handler) throw new AppError(422, 'no_result_handler', 'Nothing accepts a result of that type.')

    // Lock order is always job_input, then run, then whatever the handler writes. Taking the run lock before
    // the handler matters: a handler row that references the run takes a shared lock on it, and two siblings
    // holding that and then asking for the exclusive lock would deadlock.
    await client.query('select 1 from app.run where id = $1 for update', [job.run_id])

    const outcome = await handler(client, {
      brandId: claims.brandId,
      jobId: claims.jobId,
      runId: job.run_id,
      result: posted.result,
    })
    await client.query(
      `update app.job_input set result_type = $2, result_hash = $3, outcome = $4::jsonb, finished_at = now()
        where job_id = $1`,
      [claims.jobId, posted.type, hash, JSON.stringify(outcome ?? null)],
    )
    await client.query(`update app.job_attempt set state = 'succeeded', ended_at = now() where id = $1`, [
      claims.attemptId,
    ])
    // The run succeeds when none of its jobs is left unfinished. The run row is already locked (above), so a
    // sibling finishing at the same moment waited for us and re-reads this job's finished_at once we commit:
    // one of the two always sees the run complete. Only a run that is still going is moved; a failed,
    // cancelled, held or needs_manual run keeps its state.
    await client.query(
      `update app.run set state = 'succeeded', finished_at = now()
        where id = $1 and state in ('created', 'running')
          and not exists (select 1 from app.job_input where run_id = $1 and finished_at is null)`,
      [job.run_id],
    )
    // Through JSON, so the first answer is exactly what a repeated post reads back from the jsonb column.
    return { status: 'applied' as const, outcome: JSON.parse(JSON.stringify(outcome ?? null)) as unknown }
  })
}
