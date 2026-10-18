import { withBrand, type Pool } from '@mkt/db'
import type { Finding } from '../audit/verify.ts'
import { errorName, type NotifyDeps } from './ports.ts'
import { emailOf, platformOwnersOf } from './recipients.ts'

export interface NewAlert {
  // Null: a platform-level alert, seen by the platform owner only.
  brandId: string | null
  severity: 1 | 2 | 3
  kind: string
  // What the alert is about (a job, a notification, a chain). While an unresolved alert has the same
  // (brand, kind, ref), raising it again creates nothing, so a recurring check cannot flood.
  ref?: string
  detail?: Record<string, unknown>
}

export interface AlertRow {
  id: string
  brand_id: string | null
  severity: number
  kind: string
  detail: Record<string, unknown> | null
}

export interface RaiseResult {
  alertId: string | null
  created: boolean
  delivered: boolean
}

// Inserts the alert (nothing, when an unresolved one with the same ref exists), then delivers it.
export async function raiseAlert(pool: Pool, deps: NotifyDeps, alert: NewAlert): Promise<RaiseResult> {
  const detail = JSON.stringify({ ...alert.detail, ...(alert.ref === undefined ? {} : { ref: alert.ref }) })
  const sql = 'select app.raise_alert($1::uuid, $2::smallint, $3, $4::jsonb) as id'
  const args = [alert.brandId, alert.severity, alert.kind, detail]
  const id = alert.brandId
    ? await withBrand(
        pool,
        alert.brandId,
        async (c) => (await c.query<{ id: string | null }>(sql, args)).rows[0]?.id,
      )
    : (await pool.query<{ id: string | null }>(sql, args)).rows[0]?.id
  if (!id) return { alertId: null, created: false, delivered: false }
  const delivered = await deliverAlert(pool, deps, {
    id,
    brand_id: alert.brandId,
    severity: alert.severity,
    kind: alert.kind,
    detail: JSON.parse(detail) as Record<string, unknown>,
  })
  return { alertId: id, created: true, delivered }
}

// Email to every platform owner and a message on the second channel. The alert is `delivered` only when the
// provider confirmed (returned a provider id) every one of them; an owner without an address, no owner at
// all, or any failure leaves it undelivered for retryAlerts. A retry sends again to those already told.
export async function deliverAlert(pool: Pool, deps: NotifyDeps, alert: AlertRow): Promise<boolean> {
  const subject = `Marketing Sarathi alert (severity ${alert.severity}): ${alert.kind.replace(/_/g, ' ')}`
  const text = `${subject}. ${alert.brand_id ? 'A brand is affected.' : 'It concerns the platform.'} Open Marketing Sarathi to see it.`
  const guard = async (what: string, send: () => Promise<{ providerId: string }>): Promise<boolean> => {
    try {
      return Boolean((await send())?.providerId)
    } catch (error) {
      deps.logger?.warn({ err: errorName(error), alert: alert.id, via: what }, 'alert not delivered')
      return false
    }
  }
  const owners = await platformOwnersOf(pool)
  let allMailed = owners.length > 0
  for (const owner of owners) {
    const ok = await guard('email', async () => {
      const to = await emailOf(pool, owner)
      if (!to) throw Object.assign(new Error('recipient'), { name: 'RecipientNotFound' })
      return deps.mailer.send({ to, subject, text })
    })
    allMailed = allMailed && ok
  }
  if (owners.length === 0) deps.logger?.warn({ alert: alert.id }, 'alert has no platform owner to email')
  const channelled = await guard('channel', () => deps.channel.send({ subject, text }))
  const delivered = allMailed && channelled
  await pool.query('select app.mark_alert_delivery($1, $2)', [alert.id, delivered])
  return delivered
}

// Tries again the alerts that no one has confirmed, oldest first. Returns how many are now delivered.
export async function retryAlerts(pool: Pool, deps: NotifyDeps, limit: number): Promise<number> {
  const { rows } = await pool.query<AlertRow>(
    'select id, brand_id, severity, kind, detail from app.undelivered_alerts($1)',
    [limit],
  )
  let delivered = 0
  for (const row of rows) if (await deliverAlert(pool, deps, row)) delivered += 1
  return delivered
}

// The verify job's onMismatch: one severity 1 alert per chain finding. The chain key is the brand's id or
// 'platform', so a brand's chain becomes that brand's alert.
export function auditMismatchHandler(pool: Pool, deps: NotifyDeps): (findings: Finding[]) => Promise<void> {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  return async (findings) => {
    for (const f of findings) {
      await raiseAlert(pool, deps, {
        brandId: UUID.test(f.chainKey) ? f.chainKey : null,
        severity: 1,
        kind: 'audit_chain_mismatch',
        ref: `${f.chainKey}:${f.kind}`,
        detail: { chain: f.chainKey, finding: f.kind, seq: f.seq ?? null },
      })
    }
  }
}

// How long a job may wait with no attempt before it is reported.
export const WAITING_JOB_AFTER_MS = 30 * 60 * 1000

const KINDS: Record<string, { kind: string; severity: 1 | 2 | 3 }> = {
  dead_job: { kind: 'dead_job', severity: 2 },
  waiting_job: { kind: 'waiting_job', severity: 3 },
  unknown_model_call: { kind: 'unknown_model_call', severity: 3 },
}

// Dead jobs, long-waiting jobs and unknown model calls become brand alerts, deduped by the job or call id.
// Returns how many alerts it created.
export async function alertOnOperationalFindings(pool: Pool, deps: NotifyDeps): Promise<number> {
  const before = new Date(deps.clock.now().getTime() - WAITING_JOB_AFTER_MS)
  const { rows } = await pool.query<{ brand_id: string; kind: string; ref: string }>(
    'select brand_id, kind, ref from app.operational_findings($1)',
    [before],
  )
  let created = 0
  for (const row of rows) {
    const map = KINDS[row.kind]
    if (!map) continue
    const result = await raiseAlert(pool, deps, {
      brandId: row.brand_id,
      severity: map.severity,
      kind: map.kind,
      ref: row.ref,
      detail: { id: row.ref },
    })
    if (result.created) created += 1
  }
  return created
}
