import type { Pool } from '@mkt/db'
import { exportAudit } from '../audit/export.ts'
import type { ExportStore } from '../audit/store.ts'
import { verifyAudit } from '../audit/verify.ts'
import { auditMismatchHandler, raiseAlert } from '../notify/alerts.ts'
import { errorName, type Clock, type NotifyDeps } from '../notify/ports.ts'
import type { FxSource } from './fx.ts'
import { cleanNonces } from './nonce.ts'

export type Duty = 'n8n_heartbeat' | 'audit_export' | 'audit_verify' | 'fx_rate' | 'nonce_cleanup'
export type DutyOutcome = 'done' | 'skipped' | 'failed' | 'not_configured'

export interface DailyDeps {
  appPool: Pool
  // The owner-view role: audit reads and verify, the export reader, and app.record_fx_rate.
  ownerViewPool: Pool
  auditWriterPool: Pool
  // Null until the write-once store exists (owner items A4 and A5).
  store: ExportStore | null
  fx: FxSource
  notify: NotifyDeps
  clock: Clock
}

// One duty may take this long; after it the duty is recorded failed and the next one starts.
export const DUTY_BUDGET_MS = 60_000
// A duty left 'running' longer than this is taken to have crashed and may be claimed again, so a crash does
// not block the rest of the UTC day.
export const RUNNING_STALE_MS = 15 * 60_000

const ORDER: Duty[] = ['audit_export', 'audit_verify', 'fx_rate', 'nonce_cleanup']

async function withBudget<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('duty timed out'), { name: 'DutyTimeout' })),
      DUTY_BUDGET_MS,
    )
  })
  try {
    return await Promise.race([work, limit])
  } finally {
    clearTimeout(timer)
  }
}

// The heartbeat proves n8n called today. It is recorded first and on every call, so the time of the latest
// call is always on record; only the first call of the day counts as a run.
async function recordHeartbeat(deps: DailyDeps, today: string): Promise<DutyOutcome> {
  const now = deps.clock.now()
  const result = await deps.appPool.query<{ inserted: boolean }>(
    `insert into app.duty_run (duty, run_date, state, detail, started_at, finished_at)
     values ('n8n_heartbeat', $1, 'done', '{}'::jsonb, $2, $2)
     on conflict (duty, run_date) do update set finished_at = excluded.finished_at
     returning (xmax = 0) as inserted`,
    [today, now],
  )
  return result.rows[0]?.inserted ? 'done' : 'skipped'
}

async function claim(deps: DailyDeps, duty: Duty, today: string): Promise<boolean> {
  const now = deps.clock.now()
  const staleBefore = new Date(now.getTime() - RUNNING_STALE_MS)
  const result = await deps.appPool.query(
    `insert into app.duty_run (duty, run_date, state, started_at) values ($1, $2, 'running', $3)
     on conflict (duty, run_date) do update
       set state = 'running', started_at = excluded.started_at, finished_at = null, detail = null
       where app.duty_run.state = 'failed' or (app.duty_run.state = 'running' and app.duty_run.started_at < $4)
     returning duty`,
    [duty, today, now, staleBefore],
  )
  return (result.rowCount ?? 0) === 1
}

async function finish(
  deps: DailyDeps,
  duty: Duty,
  today: string,
  state: 'done' | 'failed' | 'not_configured',
  detail: Record<string, unknown>,
): Promise<void> {
  await deps.appPool.query(
    `update app.duty_run set state = $3, detail = $4::jsonb, finished_at = $5 where duty = $1 and run_date = $2`,
    [duty, today, state, JSON.stringify(detail), deps.clock.now()],
  )
}

type Work = () => Promise<{ state: 'done' | 'not_configured'; detail: Record<string, unknown> }>

function workOf(deps: DailyDeps, duty: Duty, today: string): Work {
  switch (duty) {
    case 'audit_export':
      return async () => {
        if (!deps.store) {
          await raiseAlert(deps.notify.pool, deps.notify, {
            brandId: null,
            severity: 2,
            kind: 'audit_export_not_configured',
            ref: 'audit_export',
            detail: {},
          })
          return { state: 'not_configured', detail: {} }
        }
        const result = await exportAudit({
          reader: deps.ownerViewPool,
          writer: deps.auditWriterPool,
          store: deps.store,
        })
        return { state: 'done', detail: result }
      }
    case 'audit_verify':
      return async () => {
        if (!deps.store) return { state: 'not_configured', detail: {} }
        const result = await verifyAudit({
          reader: deps.ownerViewPool,
          store: deps.store,
          onMismatch: auditMismatchHandler(deps.appPool, deps.notify),
        })
        return {
          state: 'done',
          detail: { ok: result.ok, chains: result.chains, findings: result.findings.length },
        }
      }
    case 'fx_rate':
      return async () => {
        const rate = await deps.fx.fetchUsdInr(today)
        await deps.ownerViewPool.query('select app.record_fx_rate($1::date, $2::bigint, $3)', [
          rate.rateDate,
          rate.rateMicros.toString(),
          rate.source,
        ])
        return { state: 'done', detail: { rateDate: rate.rateDate, source: rate.source } }
      }
    default:
      return async () => ({ state: 'done', detail: { removed: await cleanNonces(deps.appPool) } })
  }
}

// The duties n8n's daily call asks for. Each runs at most once per UTC date: a done one is skipped, a failed
// one runs again on the retry, and one left running past RUNNING_STALE_MS is taken over.
export async function runDailyDuties(deps: DailyDeps, today: string): Promise<Record<Duty, DutyOutcome>> {
  const outcome = { n8n_heartbeat: await recordHeartbeat(deps, today) } as Record<Duty, DutyOutcome>
  for (const duty of ORDER) {
    if (!(await claim(deps, duty, today))) {
      outcome[duty] = 'skipped'
      continue
    }
    try {
      const done = await withBudget(workOf(deps, duty, today)())
      await finish(deps, duty, today, done.state, done.detail)
      outcome[duty] = done.state
    } catch (error) {
      // The name only: a message can hold an address, a response body or a key.
      const name = errorName(error)
      deps.notify.logger?.error({ err: name, duty }, 'daily duty failed')
      await finish(deps, duty, today, 'failed', { error: name })
      outcome[duty] = 'failed'
    }
  }
  return outcome
}
