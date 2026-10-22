'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { api } from '../api/client'
import { alert as alertSchema, alertsReply, brandsReply } from '../api/schemas'
import { roleIn } from '../api/session'
import { useLoad } from '../api/use-load'
import { Empty } from '../frame/Empty'
import { canSeeDeadLetters } from '../frame/gating'
import { LoadError } from '../frame/LoadError'
import { useShell } from '../frame/shell-context'
import { formatTime, words } from './format'

export type Alert = z.infer<typeof alertSchema>

type Target = 'dead' | 'audit' | 'agents'

// What each kind the core raises means, and which screen deals with it.
const KINDS: Record<string, { label: string; target?: Target }> = {
  dead_job: { label: 'A job is in dead letters', target: 'dead' },
  waiting_job: { label: 'A job has waited too long to run', target: 'agents' },
  unknown_model_call: { label: 'A model call ended with an unknown outcome', target: 'agents' },
  audit_chain_mismatch: { label: 'The audit log does not match its check', target: 'audit' },
  audit_export_not_configured: { label: 'The audit export is not set up' },
  n8n_heartbeat_missing: { label: 'The workflow runner (n8n) has not checked in' },
  notification_failed: { label: 'An email could not be delivered' },
}

const TARGETS: Record<Target, { label: string; path: (brandId: string) => string }> = {
  dead: { label: 'Dead letters', path: (b) => `/b/${b}/agents/dead-letters` },
  audit: { label: 'Audit log', path: (b) => `/b/${b}/settings/audit` },
  agents: { label: 'Agents', path: (b) => `/b/${b}/agents` },
}

function severityTone(severity: number): string {
  if (severity <= 1) return 'danger'
  if (severity === 2) return 'warn'
  return 'info'
}

function delivery(alert: Alert): string {
  if (alert.delivered) return 'Delivered'
  const tries = `${alert.deliveryAttempts} ${alert.deliveryAttempts === 1 ? 'attempt' : 'attempts'}`
  if (alert.deliveryStalled) {
    return `Delivery stalled after ${tries}${alert.deliveryIssue ? ` (${words(alert.deliveryIssue)})` : ''}`
  }
  return alert.deliveryAttempts > 0 ? `Not delivered yet, ${tries}` : 'Not delivered yet'
}

export function AlertList(props: {
  // Null for the platform's own alerts, which belong to no brand's screens.
  brandId: string | null
  alerts: Alert[]
  canAck: boolean
  // Dead letters open for the platform owner only (the core refuses anyone else); nobody else gets the link.
  canSeeDeadLetters: boolean
  busyId: string | null
  error: string | null
  onAck: (id: string) => void
}) {
  const open = props.alerts.filter((a) => !a.acknowledgedAt && !a.resolvedAt)
  const closed = props.alerts.filter((a) => a.acknowledgedAt || a.resolvedAt)
  const brandId = props.brandId
  const reachable = (target: Target | undefined) =>
    target !== undefined && (target !== 'dead' || props.canSeeDeadLetters)
  return (
    <>
      <section className="sec" aria-labelledby="h-open">
        <div className="sec-head">
          <h2 id="h-open">Open alerts</h2>
          <p>{open.length}</p>
          {brandId ? (
            <span className="more row">
              {props.canSeeDeadLetters ? <Link href={TARGETS.dead.path(brandId)}>Dead letters</Link> : null}
              <Link href={TARGETS.audit.path(brandId)}>Audit log</Link>
            </span>
          ) : null}
        </div>
        {props.error ? (
          <p className="errtext mb-4" role="alert">
            {props.error}
          </p>
        ) : null}
        {open.length === 0 ? (
          <Empty title="No open alerts">
            <p>
              Alerts appear here when a job fails for good, a delivery stalls or the audit check finds a
              problem.
            </p>
          </Empty>
        ) : (
          <div className="panel">
            <ul className="list">
              {open.map((a) => {
                const kind = KINDS[a.kind]
                const target = brandId && kind?.target && reachable(kind.target) ? TARGETS[kind.target] : null
                return (
                  <li key={a.id} className="wrap-row">
                    <span className={`tag ${severityTone(a.severity)}`}>{`Severity ${a.severity}`}</span>
                    <div className="grow">
                      <b>{kind?.label ?? words(a.kind)}</b>
                      <div className="muted small">
                        Raised <time dateTime={a.raisedAt}>{formatTime(a.raisedAt)}</time>
                        {` · ${delivery(a)}`}
                      </div>
                    </div>
                    {target && brandId ? (
                      <Link className="btn sm" href={target.path(brandId)}>
                        {target.label}
                      </Link>
                    ) : null}
                    {props.canAck ? (
                      <button
                        className="btn sm"
                        type="button"
                        disabled={props.busyId !== null}
                        onClick={() => props.onAck(a.id)}
                      >
                        Acknowledge
                      </button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </section>
      {closed.length > 0 ? (
        <section className="sec" aria-labelledby="h-closed">
          <div className="sec-head">
            <h2 id="h-closed">Acknowledged and resolved</h2>
          </div>
          <div className="panel">
            <ul className="list">
              {closed.map((a) => (
                <li key={a.id}>
                  <span className="dot ok" />
                  <div>
                    <b>{KINDS[a.kind]?.label ?? words(a.kind)}</b>
                    <div className="muted small">
                      {a.resolvedAt ? 'Resolved ' : 'Acknowledged '}
                      <time dateTime={a.resolvedAt ?? a.acknowledgedAt ?? a.raisedAt}>
                        {formatTime(a.resolvedAt ?? a.acknowledgedAt ?? a.raisedAt)}
                      </time>
                      {` · severity ${a.severity}`}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </>
  )
}

// Loads one list of alerts and acknowledges them through `ackPath`; the acknowledged alert comes back from
// the core and replaces the one shown.
function useAlerts(listPath: string | null, ackPath: (id: string) => string) {
  const loaded = useLoad(
    () => (listPath ? api(alertsReply, 'GET', listPath) : Promise.resolve({ alerts: [] })),
    listPath ?? 'none',
  )
  const [alerts, setAlerts] = useState<Alert[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (loaded.state === 'ready') setAlerts(loaded.data.alerts)
  }, [loaded.state, loaded.data])
  const ack = async (id: string) => {
    setBusyId(id)
    setError(null)
    try {
      const updated = await api(alertSchema, 'POST', ackPath(id), {})
      setAlerts((now) => (now ?? []).map((a) => (a.id === id ? updated : a)))
    } catch {
      setError('The alert could not be acknowledged. Try again.')
    } finally {
      setBusyId(null)
    }
  }
  return { loaded, alerts, busyId, error, ack }
}

const HEAD = (
  <div className="page-head">
    <div>
      <h1>Alerts and incidents</h1>
      <p>What needs attention. Severity 1 is the most serious.</p>
    </div>
  </div>
)

export function BrandAlertsScreen({ brandId }: { brandId: string }) {
  const { session } = useShell()
  const role = roleIn(session, brandId)
  const canAck = role === 'owner' || role === 'brand_admin' || role === 'approver'
  const view = useAlerts(`/brands/${brandId}/alerts`, (id) => `/brands/${brandId}/alerts/${id}/ack`)
  return (
    <main id="content" className="page">
      {HEAD}
      {view.loaded.state === 'error' ? (
        <LoadError what="the alerts" error={view.loaded.error} onRetry={view.loaded.retry} />
      ) : view.alerts ? (
        <AlertList
          brandId={brandId}
          alerts={view.alerts}
          canAck={canAck}
          canSeeDeadLetters={canSeeDeadLetters(session)}
          busyId={view.busyId}
          error={view.error}
          onAck={(id) => void view.ack(id)}
        />
      ) : (
        <p className="muted">Loading…</p>
      )}
    </main>
  )
}

// /alerts: the platform's own alerts for the owner, and a way to each brand's alerts. A brand admin of exactly
// one brand goes straight to that brand's alerts.
export function AllAlertsScreen() {
  const router = useRouter()
  const { session } = useShell()
  const owner = session.platformOwner
  const view = useAlerts(owner ? '/alerts' : null, (id) => `/alerts/${id}/ack`)
  const brands = useLoad(() => api(brandsReply, 'GET', '/brands'), 'brands')
  const managed =
    brands.state === 'ready'
      ? brands.data.brands.filter((b) => owner || roleIn(session, b.id) === 'brand_admin')
      : []
  const only = !owner && brands.state === 'ready' && managed.length === 1 ? managed[0] : undefined
  useEffect(() => {
    if (only) router.replace(`/b/${only.id}/alerts`)
  }, [only, router])
  if (only) return <p className="page muted">Loading…</p>
  return (
    <main id="content" className="page">
      {HEAD}
      {owner ? (
        view.loaded.state === 'error' ? (
          <LoadError what="the platform alerts" error={view.loaded.error} onRetry={view.loaded.retry} />
        ) : view.alerts ? (
          <AlertList
            brandId={null}
            alerts={view.alerts}
            canAck
            canSeeDeadLetters={canSeeDeadLetters(session)}
            busyId={view.busyId}
            error={view.error}
            onAck={(id) => void view.ack(id)}
          />
        ) : (
          <p className="muted">Loading…</p>
        )
      ) : null}
      <section className="sec" aria-labelledby="h-brands">
        <div className="sec-head">
          <h2 id="h-brands">Alerts for each brand</h2>
        </div>
        {brands.state === 'error' ? (
          <LoadError what="your brands" error={brands.error} onRetry={brands.retry} />
        ) : brands.state === 'loading' ? (
          <p className="muted">Loading…</p>
        ) : managed.length === 0 ? (
          <Empty title="No brand to show">
            <p>Alerts belong to the brands you manage.</p>
          </Empty>
        ) : (
          <div className="panel">
            <ul className="list">
              {managed.map((b) => (
                <li key={b.id}>
                  <b>{b.name}</b>
                  <Link className="sp btn sm" href={`/b/${b.id}/alerts`}>
                    Open alerts
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  )
}
