import type { PoolClient } from '@mkt/db'
import { z } from 'zod'
import { AppError } from '../errors.ts'

// Read queries for the screens. All of them run inside withBrand, so the database's own row security keeps
// them to one brand; every query also names the brand. Money leaves as text: the columns are bigint
// millionths, and a JavaScript number would lose digits.

export interface Money {
  usdMicros: string
  inrMicros: string
}

export const RUNS_PAGE = 50
const REVIEW_LIMIT = 200
const LAST_RUNS = 5

// The first instant of the month `now` falls in, UTC.
export const monthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

const money = (usd: string | null, inr: string | null): Money => ({
  usdMicros: usd ?? '0',
  inrMicros: inr ?? '0',
})
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null)

// --- agents ---------------------------------------------------------------------------------------------

export interface AgentView {
  agent: string
  version: number
  model: string
  effort: string
  state: 'running' | 'blocked' | 'idle'
  costThisMonth: Money
}

export async function listAgents(client: PoolClient, brandId: string, now: Date): Promise<AgentView[]> {
  const { rows } = await client.query<{
    agent: string
    version: number
    model: string
    effort: string
    running: boolean
    blocked: boolean
    usd: string
    inr: string
  }>(
    `select d.agent, d.version, d.model, d.effort,
            exists (select 1 from app.run r
                     where r.brand_id = $1 and r.agent = d.agent and r.state = 'running') as running,
            exists (select 1 from app.kill_switch k
                     where k.brand_id = $1 and k.active
                       and (k.scope = 'brand' or (k.scope = 'agent' and k.target = d.agent))) as blocked,
            coalesce((select sum(c.usd_micros) from app.cost_ledger c
                       where c.brand_id = $1 and c.agent = d.agent and c.at >= $2), 0)::text as usd,
            coalesce((select sum(c.inr_micros) from app.cost_ledger c
                       where c.brand_id = $1 and c.agent = d.agent and c.at >= $2), 0)::text as inr
       from app.agent_definition_version d
      where d.live
      order by d.agent`,
    [brandId, monthStart(now)],
  )
  return rows.map((r) => ({
    agent: r.agent,
    version: r.version,
    model: r.model,
    effort: r.effort,
    state: r.running ? 'running' : r.blocked ? 'blocked' : 'idle',
    costThisMonth: money(r.usd, r.inr),
  }))
}

// --- runs -----------------------------------------------------------------------------------------------

export interface RunSummary {
  id: string
  agent: string
  state: string
  startedByKind: string
  startedAt: string
  finishedAt: string | null
  cost: Money
}

interface RunRow {
  id: string
  agent: string
  state: string
  started_by_kind: string
  started_at: Date
  finished_at: Date | null
  usd: string
  inr: string
  cursor_at: string
}

const RUN_COLUMNS = `r.id, r.agent, r.state, r.started_by_kind, r.started_at, r.finished_at,
  to_char(r.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at,
  coalesce((select sum(c.usd_micros) from app.cost_ledger c where c.brand_id = r.brand_id and c.run_id = r.id), 0)::text as usd,
  coalesce((select sum(c.inr_micros) from app.cost_ledger c where c.brand_id = r.brand_id and c.run_id = r.id), 0)::text as inr`

const runView = (r: RunRow): RunSummary => ({
  id: r.id,
  agent: r.agent,
  state: r.state,
  startedByKind: r.started_by_kind,
  startedAt: r.started_at.toISOString(),
  finishedAt: isoOrNull(r.finished_at),
  cost: money(r.usd, r.inr),
})

// The cursor is the last run's start time (to the microsecond, as text) and its id.
export const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f-]{36})$/i

// The cursor must also name a real moment and a real id: the pattern alone lets 2026-13-45 through to the
// database, which would answer with an error instead of a refusal.
export function cursorIsReal(cursor: string): boolean {
  const match = CURSOR.exec(cursor)
  if (!match) return false
  const at = new Date(match[1]!.replace(/\d{3}Z$/, 'Z'))
  // Round trip: a day that does not exist (Feb 30) rolls over, so it comes back different.
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 19) !== match[1]!.slice(0, 19)) return false
  return z.uuid().safeParse(match[2]).success
}

export async function listRuns(
  client: PoolClient,
  brandId: string,
  options: { agent?: string; cursor?: string },
): Promise<{ items: RunSummary[]; nextCursor: string | null }> {
  const cursor = options.cursor ? CURSOR.exec(options.cursor) : null
  const { rows } = await client.query<RunRow>(
    `select ${RUN_COLUMNS}
       from app.run r
      where r.brand_id = $1
        and ($2::text is null or r.agent = $2)
        and ($3::timestamptz is null or (r.started_at, r.id) < ($3::timestamptz, $4::uuid))
      order by r.started_at desc, r.id desc
      limit ${RUNS_PAGE + 1}`,
    [brandId, options.agent ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null],
  )
  const page = rows.slice(0, RUNS_PAGE)
  const last = page[page.length - 1]
  return {
    items: page.map(runView),
    nextCursor: rows.length > RUNS_PAGE && last ? `${last.cursor_at}_${last.id}` : null,
  }
}

export interface ModelCallView {
  id: string
  runId: string
  jobId: string
  step: string
  model: string
  status: string
  possibleDuplicate: boolean
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  cost: Money | null
  startedAt: string
  finishedAt: string | null
}

interface CallRow {
  id: string
  run_id: string
  job_id: string
  step: string
  model: string
  status: string
  possible_duplicate: boolean
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  usd: string | null
  inr: string | null
  started_at: Date
  finished_at: Date | null
}

const CALL_COLUMNS = `m.id, m.run_id, m.job_id, m.step, m.model, m.status, m.possible_duplicate,
  m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_write_tokens,
  m.usd_micros::text as usd, m.inr_micros::text as inr, m.started_at, m.finished_at`

const callView = (r: CallRow): ModelCallView => ({
  id: r.id,
  runId: r.run_id,
  jobId: r.job_id,
  step: r.step,
  model: r.model,
  status: r.status,
  possibleDuplicate: r.possible_duplicate,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cacheReadTokens: r.cache_read_tokens,
  cacheWriteTokens: r.cache_write_tokens,
  cost: r.usd === null || r.inr === null ? null : { usdMicros: r.usd, inrMicros: r.inr },
  startedAt: r.started_at.toISOString(),
  finishedAt: isoOrNull(r.finished_at),
})

// The state of a job as the screens name it. The queue is not asked: the core's own rows say it.
const JOB_STATE = `case
    when i.finished_at is not null then 'finished'
    when c.dead_at is not null then 'dead'
    when c.held then 'held'
    when exists (select 1 from app.job_attempt a where a.job_id = i.job_id and a.state = 'active') then 'running'
    else 'waiting' end`

export interface JobView {
  id: string
  jobClass: string
  state: 'waiting' | 'running' | 'held' | 'dead' | 'finished'
  expectedResultType: string
  resultType: string | null
  createdAt: string
  finishedAt: string | null
  attempts: { number: number; workerId: string; state: string; startedAt: string; endedAt: string | null }[]
}

export interface RunDetail {
  run: RunSummary
  jobs: JobView[]
  modelCalls: ModelCallView[]
  cost: Money
}

export async function runDetail(client: PoolClient, brandId: string, runId: string): Promise<RunDetail> {
  const run = await client.query<RunRow>(
    `select ${RUN_COLUMNS} from app.run r where r.brand_id = $1 and r.id = $2`,
    [brandId, runId],
  )
  const found = run.rows[0]
  if (!found) throw new AppError(404, 'not_found', 'There is nothing at this address.')
  const jobs = await client.query<{
    job_id: string
    class: string
    state: JobView['state']
    expected_result_type: string
    result_type: string | null
    created_at: Date
    finished_at: Date | null
  }>(
    `select i.job_id, i.class, ${JOB_STATE} as state, i.expected_result_type, i.result_type, i.created_at, i.finished_at
       from app.job_input i join app.job_control c on c.job_id = i.job_id
      where i.brand_id = $1 and i.run_id = $2
      order by i.created_at, i.job_id`,
    [brandId, runId],
  )
  const attempts = await client.query<{
    job_id: string
    attempt_number: number
    worker_id: string
    state: string
    started_at: Date
    ended_at: Date | null
  }>(
    `select a.job_id, a.attempt_number, a.worker_id, a.state, a.started_at, a.ended_at
       from app.job_attempt a join app.job_input i on i.job_id = a.job_id
      where i.brand_id = $1 and i.run_id = $2 and a.brand_id = $1
      order by a.job_id, a.attempt_number`,
    [brandId, runId],
  )
  const calls = await client.query<CallRow>(
    `select ${CALL_COLUMNS} from app.model_call m where m.brand_id = $1 and m.run_id = $2 order by m.started_at, m.id`,
    [brandId, runId],
  )
  return {
    run: runView(found),
    jobs: jobs.rows.map((j) => ({
      id: j.job_id,
      jobClass: j.class,
      state: j.state,
      expectedResultType: j.expected_result_type,
      resultType: j.result_type,
      createdAt: j.created_at.toISOString(),
      finishedAt: isoOrNull(j.finished_at),
      attempts: attempts.rows
        .filter((a) => a.job_id === j.job_id)
        .map((a) => ({
          number: a.attempt_number,
          workerId: a.worker_id,
          state: a.state,
          startedAt: a.started_at.toISOString(),
          endedAt: isoOrNull(a.ended_at),
        })),
    })),
    modelCalls: calls.rows.map(callView),
    cost: money(found.usd, found.inr),
  }
}

// --- model-call review ----------------------------------------------------------------------------------

// Calls a person should look at: the outcome is unknown, the call may have been sent twice, or it succeeded
// and no cost row was written for it (milestone 4 "not built").
const REVIEW_WHERE = `m.brand_id = $1 and (
    m.status = 'unknown' or m.possible_duplicate
    or (m.status = 'succeeded' and not exists (select 1 from app.cost_ledger c where c.model_call_id = m.id)))`

export interface ReviewCallView extends ModelCallView {
  reason: 'unknown' | 'possible_duplicate' | 'no_cost'
}

export async function reviewCalls(
  client: PoolClient,
  brandId: string,
): Promise<{ items: ReviewCallView[]; truncated: boolean }> {
  const { rows } = await client.query<CallRow>(
    `select ${CALL_COLUMNS} from app.model_call m where ${REVIEW_WHERE}
      order by m.started_at desc, m.id limit ${REVIEW_LIMIT + 1}`,
    [brandId],
  )
  return {
    items: rows.slice(0, REVIEW_LIMIT).map((r) => ({
      ...callView(r),
      reason: r.status === 'unknown' ? 'unknown' : r.possible_duplicate ? 'possible_duplicate' : 'no_cost',
    })),
    truncated: rows.length > REVIEW_LIMIT,
  }
}

export async function countReviewCalls(client: PoolClient, brandId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `select count(*)::text as n from app.model_call m where ${REVIEW_WHERE}`,
    [brandId],
  )
  return Number(rows[0]?.n ?? 0)
}

// --- home -----------------------------------------------------------------------------------------------

export interface Results {
  runsThisMonth: number
  costThisMonth: Money
  lastRuns: RunSummary[]
}

export async function homeResults(client: PoolClient, brandId: string, now: Date): Promise<Results> {
  const since = monthStart(now)
  const totals = await client.query<{ runs: string }>(
    'select count(*)::text as runs from app.run where brand_id = $1 and started_at >= $2',
    [brandId, since],
  )
  const cost = await client.query<{ usd: string; inr: string }>(
    `select coalesce(sum(usd_micros), 0)::text as usd, coalesce(sum(inr_micros), 0)::text as inr
       from app.cost_ledger where brand_id = $1 and at >= $2`,
    [brandId, since],
  )
  const last = await client.query<RunRow>(
    `select ${RUN_COLUMNS} from app.run r where r.brand_id = $1 order by r.started_at desc, r.id desc limit ${LAST_RUNS}`,
    [brandId],
  )
  return {
    runsThisMonth: Number(totals.rows[0]?.runs ?? 0),
    costThisMonth: money(cost.rows[0]?.usd ?? null, cost.rows[0]?.inr ?? null),
    lastRuns: last.rows.map(runView),
  }
}

export type JobCounts = Record<'waiting' | 'running' | 'held' | 'dead' | 'finished', number>

export async function jobCounts(client: PoolClient, brandId: string): Promise<JobCounts> {
  const { rows } = await client.query<{ state: keyof JobCounts; n: string }>(
    `select ${JOB_STATE} as state, count(*)::text as n
       from app.job_input i join app.job_control c on c.job_id = i.job_id
      where i.brand_id = $1 group by 1`,
    [brandId],
  )
  const counts: JobCounts = { waiting: 0, running: 0, held: 0, dead: 0, finished: 0 }
  for (const r of rows) counts[r.state] = Number(r.n)
  return counts
}

export async function awaitingApproval(
  client: PoolClient,
  brandId: string,
): Promise<{ awaitingApproval: number; oldestWaitingSince: string | null }> {
  const { rows } = await client.query<{ n: string; oldest: Date | null }>(
    `select count(*)::text as n, min(updated_at) as oldest
       from app.content_version_state where brand_id = $1 and state = 'awaiting_approval'`,
    [brandId],
  )
  return {
    awaitingApproval: Number(rows[0]?.n ?? 0),
    oldestWaitingSince: isoOrNull(rows[0]?.oldest ?? null),
  }
}

export async function problemCounts(
  client: PoolClient,
  brandId: string,
): Promise<{ deadJobs: number; openAlerts: number; reviewCalls: number }> {
  const dead = await client.query<{ n: string }>(
    `select count(*)::text as n from app.job_control c join app.job_input i on i.job_id = c.job_id
      where c.brand_id = $1 and c.dead_at is not null and i.finished_at is null`,
    [brandId],
  )
  const alerts = await client.query<{ n: string }>(
    'select count(*)::text as n from app.alert where brand_id = $1 and resolved_at is null',
    [brandId],
  )
  return {
    deadJobs: Number(dead.rows[0]?.n ?? 0),
    openAlerts: Number(alerts.rows[0]?.n ?? 0),
    reviewCalls: await countReviewCalls(client, brandId),
  }
}
