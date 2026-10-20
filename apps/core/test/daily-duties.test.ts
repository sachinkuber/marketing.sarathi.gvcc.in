import { randomBytes } from 'node:crypto'
import { createPool, type Pool } from '@mkt/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DbAudit } from '../src/audit/db-audit.ts'
import { MemoryExportStore, type ExportMark } from '../src/audit/store.ts'
import { DoubleAlertChannel, DoubleMailer } from '../src/notify/doubles.ts'
import type { NotifyDeps } from '../src/notify/ports.ts'
import { runDailyDuties, type DailyDeps, type Duty } from '../src/triggers/duties.ts'
import { StandInFxSource } from '../src/triggers/fx.ts'
import { sign, signingText } from '../src/triggers/signature.ts'
import { TRIGGER_SECRET, createStack, type Stack } from './support.ts'

const FIXED_SECONDS = 1_900_000_000
const TODAY = new Date(FIXED_SECONDS * 1000).toISOString().slice(0, 10)
const DUTIES: Duty[] = ['n8n_heartbeat', 'audit_export', 'audit_verify', 'fx_rate', 'nonce_cleanup']

// An export store whose marks can be made to disagree with the log, as a tampered copy would.
class TamperedStore extends MemoryExportStore {
  tamper = false
  override async marks(chainKey: string): Promise<ExportMark[]> {
    const marks = await super.marks(chainKey)
    return this.tamper ? marks.map((m) => ({ ...m, chainHash: 'f'.repeat(64) })) : marks
  }
}

let stack: Stack
let fx: StandInFxSource
let store: TamperedStore
let logged: string[]
let ownerView: Pool
let deps: DailyDeps

beforeAll(async () => {
  fx = new StandInFxSource(83_354_976n)
  store = new TamperedStore()
  stack = await createStack({
    realAudit: true,
    clock: { now: () => new Date(FIXED_SECONDS * 1000) },
    daily: { fx, store },
  })
  ownerView = stack.ownerViewPool!
})
afterAll(async () => {
  await stack?.close()
})
beforeEach(async () => {
  logged = []
  fx.failures = 0
  fx.calls = 0
  store.tamper = false
  const sink = (...args: unknown[]) => void logged.push(JSON.stringify(args))
  const notify: NotifyDeps = {
    pool: stack.appPool,
    mailer: new DoubleMailer(),
    channel: new DoubleAlertChannel(),
    clock: { now: () => new Date(FIXED_SECONDS * 1000) },
    audit: new DbAudit(stack.auditPool!),
    logger: { warn: sink, error: sink } as NotifyDeps['logger'],
  }
  deps = {
    appPool: stack.appPool,
    ownerViewPool: ownerView,
    auditWriterPool: stack.auditPool!,
    store,
    fx,
    notify,
    clock: notify.clock,
  }
  await stack.db.admin.query('delete from app.duty_run')
  await stack.db.admin.query('delete from app.alert')
  await stack.db.admin.query('delete from app.fx_rate')
})

const dutyRows = async () =>
  (
    await stack.db.admin.query(
      'select duty, run_date::text as d, state, detail from app.duty_run order by duty',
    )
  ).rows
const alerts = async () => (await stack.db.admin.query('select * from app.alert order by raised_at')).rows
const allOutcomes = (value: string) => Object.fromEntries(DUTIES.map((d) => [d, value]))

describe('runDailyDuties', () => {
  it('runs each duty once a day and answers skipped for each the second time', async () => {
    expect(await runDailyDuties(deps, TODAY)).toEqual(allOutcomes('done'))
    expect(fx.calls).toBe(1)
    expect(await runDailyDuties(deps, TODAY)).toEqual(allOutcomes('skipped'))
    expect(fx.calls).toBe(1)
    const rows = await dutyRows()
    expect(rows.map((r) => [r.duty, r.d, r.state])).toEqual(
      DUTIES.map((d) => [d, TODAY, 'done']).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    )
    // The next date runs them again.
    expect(await runDailyDuties(deps, '2030-03-18')).toEqual(allOutcomes('done'))
  })

  it('stores the day exchange rate through the owner-view role, once', async () => {
    await runDailyDuties(deps, TODAY)
    const rate = await stack.db.admin.query(
      'select rate_date::text as d, rate_micros::text as m, source from app.fx_rate',
    )
    expect(rate.rows).toEqual([{ d: TODAY, m: '83354976', source: 'stand-in' }])
  })

  it('records the heartbeat first and always, even when the owner-view connection is down', async () => {
    const dead = createPool(stack.db.urlFor('owner_view'))
    await dead.end()
    const out = await runDailyDuties({ ...deps, ownerViewPool: dead }, TODAY)
    expect(out).toEqual({
      ...allOutcomes('done'),
      audit_export: 'failed',
      audit_verify: 'failed',
      fx_rate: 'failed',
    })
    expect((await dutyRows()).find((r) => r.duty === 'n8n_heartbeat')?.state).toBe('done')
  })

  it('refreshes the heartbeat time on a repeated call', async () => {
    await runDailyDuties(deps, TODAY)
    const first = (
      await stack.db.admin.query("select finished_at from app.duty_run where duty = 'n8n_heartbeat'")
    ).rows[0]
    await stack.db.admin.query(
      "update app.duty_run set finished_at = finished_at - interval '1 hour' where duty = 'n8n_heartbeat'",
    )
    await runDailyDuties(deps, TODAY)
    const again = (
      await stack.db.admin.query("select finished_at from app.duty_run where duty = 'n8n_heartbeat'")
    ).rows[0]
    expect(again.finished_at).toEqual(first.finished_at)
  })

  it('records a failed rate fetch as failed, runs the rest, and the retry runs only the rate', async () => {
    fx.failNext(1)
    const first = await runDailyDuties(deps, TODAY)
    expect(first).toEqual({ ...allOutcomes('done'), fx_rate: 'failed' })
    const row = (await dutyRows()).find((r) => r.duty === 'fx_rate')
    expect(row?.state).toBe('failed')
    expect(row?.detail).toEqual({ error: 'Error' })
    const retry = await runDailyDuties(deps, TODAY)
    expect(retry).toEqual({ ...allOutcomes('skipped'), fx_rate: 'done' })
    expect(fx.calls).toBe(2)
  })

  it('logs a failure by error name only, never its message', async () => {
    fx.failNext(1)
    fx.message = 'https://secret.example/key=abc123 body <html>'
    await runDailyDuties(deps, TODAY)
    expect(logged.length).toBeGreaterThan(0)
    expect(logged.join('')).not.toContain('abc123')
    expect(logged.join('')).not.toContain('secret.example')
  })

  it('takes over a duty left running longer than 15 minutes, not one that started 5 minutes ago', async () => {
    await stack.db.admin.query(
      `insert into app.duty_run (duty, run_date, state, started_at) values
        ('fx_rate', $1, 'running', $2), ('nonce_cleanup', $1, 'running', $3)`,
      [TODAY, new Date(FIXED_SECONDS * 1000 - 20 * 60_000), new Date(FIXED_SECONDS * 1000 - 5 * 60_000)],
    )
    const out = await runDailyDuties(deps, TODAY)
    expect(out.fx_rate).toBe('done')
    expect(out.nonce_cleanup).toBe('skipped')
  })

  it('removes nonces older than the retention and keeps newer ones', async () => {
    const old = randomBytes(32).toString('hex')
    const recent = randomBytes(32).toString('hex')
    await stack.db.admin.query(
      `insert into app.trigger_nonce (nonce, received_at) values
        (decode($1, 'hex'), now() - interval '12 minutes'), (decode($2, 'hex'), now() - interval '5 minutes')`,
      [old, recent],
    )
    await runDailyDuties(deps, TODAY)
    const left = await stack.db.admin.query("select encode(nonce, 'hex') as n from app.trigger_nonce")
    expect(left.rows.map((r) => r.n)).toContain(recent)
    expect(left.rows.map((r) => r.n)).not.toContain(old)
    const row = (await dutyRows()).find((r) => r.duty === 'nonce_cleanup')
    expect((row?.detail as { removed: number }).removed).toBeGreaterThanOrEqual(1)
  })

  it('without an export store: not configured, one severity 2 alert, and none again on another day', async () => {
    const out = await runDailyDuties({ ...deps, store: null }, TODAY)
    expect(out).toEqual({
      ...allOutcomes('done'),
      audit_export: 'not_configured',
      audit_verify: 'not_configured',
    })
    expect(await runDailyDuties({ ...deps, store: null }, TODAY)).toEqual(allOutcomes('skipped'))
    await runDailyDuties({ ...deps, store: null }, '2030-03-18')
    const rows = await alerts()
    expect(rows.map((r) => [r.brand_id, r.severity, r.kind])).toEqual([
      [null, 2, 'audit_export_not_configured'],
    ])
  })

  it('exports the log, and raises a severity 1 alert when an export mark no longer matches', async () => {
    await new DbAudit(stack.auditPool!).record({
      action: 'test.entry',
      actor: null,
      brandId: null,
      outcome: 'success',
      detail: {},
    })
    expect(await runDailyDuties(deps, TODAY)).toEqual(allOutcomes('done'))
    expect((await store.chainKeys()).length).toBeGreaterThan(0)
    expect(await alerts()).toHaveLength(0)
    store.tamper = true
    const second = await runDailyDuties(deps, '2030-03-18')
    expect(second.audit_verify).toBe('done')
    const rows = await alerts()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.severity === 1 && r.kind === 'audit_chain_mismatch')).toBe(true)
    const verify = (await dutyRows()).find((r) => r.duty === 'audit_verify' && r.d === '2030-03-18')
    expect((verify?.detail as { ok: boolean }).ok).toBe(false)
  })
})

// The caller n8n is.
const PATH = '/api/v1/triggers/daily'
const post = (body: string, path = PATH) => {
  const nonce = randomBytes(32).toString('hex')
  const ts = String(FIXED_SECONDS)
  return fetch(stack.server.url + path, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-mkt-timestamp': ts,
      'x-mkt-nonce': nonce,
      'x-mkt-signature': sign(TRIGGER_SECRET, signingText('POST', path, ts, nonce, Buffer.from(body))),
    },
  })
}
const BODY = '{"workflow":"marketing-daily-heartbeat"}'

describe('POST /triggers/daily', () => {
  it('answers 200 with the outcome of each duty, then skipped on the repeat', async () => {
    const res = await post(BODY)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ duties: allOutcomes('done') })
    const again = await post(BODY)
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ duties: allOutcomes('skipped') })
  })

  it('answers 502 with the same body when a duty failed, so n8n retries; the retry runs only that duty', async () => {
    fx.failNext(1)
    const res = await post(BODY)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ duties: { ...allOutcomes('done'), fx_rate: 'failed' } })
    const retry = await post(BODY)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ duties: { ...allOutcomes('skipped'), fx_rate: 'done' } })
  })

  it('refuses another workflow name and extra fields with 400', async () => {
    expect((await post('{"workflow":"daily"}')).status).toBe(400)
    expect((await post('{"workflow":"marketing-daily-heartbeat","x":1}')).status).toBe(400)
    expect(await dutyRows()).toHaveLength(0)
  })

  it('refuses an unsigned call', async () => {
    const res = await fetch(stack.server.url + PATH, { method: 'POST', body: BODY })
    expect([401, 403]).toContain(res.status)
    expect(await dutyRows()).toHaveLength(0)
  })
})
