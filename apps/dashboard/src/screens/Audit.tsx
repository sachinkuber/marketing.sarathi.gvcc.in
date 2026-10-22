'use client'
import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { ApiError, api } from '../api/client'
import { auditReply, auditVerifyReply, usersReply } from '../api/schemas'
import { roleIn } from '../api/session'
import { useLoad } from '../api/use-load'
import { Empty } from '../frame/Empty'
import { LoadError } from '../frame/LoadError'
import { useShell } from '../frame/shell-context'
import { ACTIONS, actionLabel, actorLabel, detailText } from './audit-words'
import { formatTime, words } from './format'

export type AuditPage = z.infer<typeof auditReply>
export type Verification = z.infer<typeof auditVerifyReply>
type Finding = Verification['findings'][number]

export interface AuditFilters {
  actor: string
  action: string
  // Calendar days as the date fields give them (YYYY-MM-DD), in the reader's own time zone.
  from: string
  to: string
}

const NO_FILTERS: AuditFilters = { actor: '', action: '', from: '', to: '' }

function dayStart(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

// The query for one page: the filters that are set, and `before` for the page after the last one read. "To" is
// the whole of that day: the core's bound is inclusive, so it is the last millisecond before the next day.
export function auditQuery(
  filters: AuditFilters,
  before?: number,
): { ok: true; query: string } | { ok: false; error: string } {
  const params = new URLSearchParams()
  if (filters.actor) params.set('actor', filters.actor)
  if (filters.action) params.set('action', filters.action)
  const from = filters.from ? dayStart(filters.from) : null
  const to = filters.to ? dayStart(filters.to) : null
  if ((filters.from && !from) || (filters.to && !to)) return { ok: false, error: 'Enter the dates as days.' }
  if (from && to && from.getTime() > to.getTime()) {
    return { ok: false, error: 'The start day is after the end day.' }
  }
  if (from) params.set('from', from.toISOString())
  if (to) {
    const end = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).getTime() - 1
    params.set('to', new Date(end).toISOString())
  }
  if (before !== undefined) params.set('before', String(before))
  const text = params.toString()
  return { ok: true, query: text ? `?${text}` : '' }
}

function finding(f: Finding): string {
  switch (f.kind) {
    case 'broken_chain':
      return `The chain breaks at entry ${f.seq ?? 'unknown'}.`
    case 'export_mismatch':
      return `The export up to entry ${f.seq ?? 'unknown'} does not match the log.`
    case 'log_shorter_than_export':
      return `The log is shorter than the export up to entry ${f.seq ?? 'unknown'}: entries are missing.`
    case 'chain_missing':
      return 'The log for this brand is empty, but exports of it exist.'
  }
}

export function VerifyResult({ result }: { result: Verification }) {
  return (
    <div className="stack">
      <div className="row wrap">
        {result.ok ? (
          <span className="tag ok">Verified</span>
        ) : (
          <span className="tag danger">Problem found</span>
        )}
        <span className="sub small">
          {result.ok
            ? 'Every entry links to the one before it, and the exports match. Checked '
            : 'The log does not match its own chain or its exports. Checked '}
          <time dateTime={result.checkedAt}>{formatTime(result.checkedAt)}</time>.
        </span>
      </div>
      {result.ok ? null : (
        <ul className="bullets">
          {result.findings.map((f) => (
            <li key={`${f.kind}:${f.seq ?? 'none'}`}>{finding(f)}</li>
          ))}
        </ul>
      )}
      <dl className="kv">
        <dt>Last export</dt>
        <dd>
          {result.lastExport ? (
            <>
              <time dateTime={result.lastExport.exportedAt}>{formatTime(result.lastExport.exportedAt)}</time>
              {` (entries up to ${result.lastExport.throughSeq})`}
            </>
          ) : (
            'No export yet'
          )}
        </dd>
      </dl>
    </div>
  )
}

function verifyFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'The platform could not be reached. Try again.'
    if (error.code === 'verify_rate_limited') return 'This was checked a moment ago. Try again in a minute.'
    if (error.code === 'verify_timeout') return 'The check took too long. Try again later.'
  }
  return 'The check could not be run. Try again.'
}

export function AuditScreen({ brandId }: { brandId: string }) {
  const { session } = useShell()
  const role = roleIn(session, brandId)
  const mayRead = role === 'owner' || role === 'brand_admin'
  const me = session.user.id
  // The brand's people, to name them in the list and to filter by them; the log reads without it.
  const people = useLoad(
    () => (mayRead ? api(usersReply, 'GET', `/brands/${brandId}/users`) : Promise.resolve(null)),
    `${brandId}:${mayRead}`,
  )
  const [form, setForm] = useState<AuditFilters>(NO_FILTERS)
  // The filters of the list on screen: "Load older" continues these, not what is typed but not applied.
  const [applied, setApplied] = useState<AuditFilters>(NO_FILTERS)
  const first = useLoad(
    () => (mayRead ? api(auditReply, 'GET', `/brands/${brandId}/audit`) : Promise.resolve(null)),
    `${brandId}:${mayRead}`,
  )
  const [page, setPage] = useState<AuditPage | null>(null)
  const [busy, setBusy] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verified, setVerified] = useState<Verification | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  useEffect(() => {
    if (first.state === 'ready' && first.data) setPage(first.data)
  }, [first.state, first.data])

  const members = people.state === 'ready' && people.data ? people.data.members : []
  const names = new Map(members.map((m) => [m.userId, m.name]))

  const read = async (filters: AuditFilters, before?: number) => {
    const query = auditQuery(filters, before)
    if (!query.ok) {
      setListError(query.error)
      return
    }
    setBusy(true)
    setListError(null)
    try {
      const next = await api(auditReply, 'GET', `/brands/${brandId}/audit${query.query}`)
      setApplied(filters)
      setPage((current) =>
        before !== undefined && current
          ? { items: [...current.items, ...next.items], nextBefore: next.nextBefore }
          : next,
      )
    } catch {
      setListError(
        before !== undefined
          ? 'Older entries could not be loaded. Try again.'
          : 'The entries could not be loaded. Try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  const verify = async () => {
    setVerifying(true)
    setVerifyError(null)
    try {
      setVerified(await api(auditVerifyReply, 'POST', `/brands/${brandId}/audit/verify`, {}))
    } catch (error) {
      setVerifyError(verifyFailure(error))
    } finally {
      setVerifying(false)
    }
  }

  const set = (key: keyof AuditFilters) => (event: { target: { value: string } }) =>
    setForm((now) => ({ ...now, [key]: event.target.value }))

  if (!mayRead) {
    return (
      <main id="content" className="page">
        <div className="callout warn" role="alert">
          Only the platform owner and the brand admin can read the audit log.
        </div>
      </main>
    )
  }

  return (
    <main id="content" className="page">
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p>A record of who did what, kept so it cannot be changed quietly afterwards.</p>
        </div>
      </div>

      <form
        className="panel pad stack"
        noValidate
        aria-label="Filter the entries"
        onSubmit={(event) => {
          event.preventDefault()
          void read(form)
        }}
      >
        <div className="grid2">
          <div className="field">
            <label htmlFor="f-person">Person</label>
            <select id="f-person" className="input" value={form.actor} onChange={set('actor')}>
              <option value="">Everyone</option>
              <option value={me}>You</option>
              {members
                .filter((m) => m.userId !== me)
                .map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {`${m.name}, ${words(m.role)}`}
                  </option>
                ))}
            </select>
            {people.state === 'error' ? (
              <span className="hint">
                The brand’s people could not be loaded; you can still filter by yourself.
              </span>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="f-action">Action</label>
            <select id="f-action" className="input" value={form.action} onChange={set('action')}>
              <option value="">Any action</option>
              {Object.entries(ACTIONS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-from">From</label>
            <input id="f-from" className="input" type="date" value={form.from} onChange={set('from')} />
          </div>
          <div className="field">
            <label htmlFor="f-to">To</label>
            <input id="f-to" className="input" type="date" value={form.to} onChange={set('to')} />
          </div>
        </div>
        <div className="row wrap">
          <button className="btn primary" type="submit" disabled={busy}>
            Apply
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => {
              setForm(NO_FILTERS)
              void read(NO_FILTERS)
            }}
          >
            Clear
          </button>
        </div>
      </form>

      <section className="sec" aria-labelledby="h-entries">
        <div className="sec-head">
          <h2 id="h-entries">Entries</h2>
          <p>Newest first</p>
        </div>
        {listError ? (
          <p className="errtext mb-4" role="alert">
            {listError}
          </p>
        ) : null}
        {first.state === 'error' && !page ? (
          <LoadError what="the audit log" error={first.error} onRetry={first.retry} />
        ) : page ? (
          page.items.length === 0 ? (
            <div className="panel">
              <Empty title="No entries match">
                <p>Every change, decision and sign-in is recorded here. Try fewer filters.</p>
              </Empty>
            </div>
          ) : (
            <>
              <div className="panel scroll-x">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Who</th>
                      <th>What</th>
                      <th>Before and after, or details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((entry) => (
                      <tr key={entry.seq}>
                        <td className="nowrap">
                          <time dateTime={entry.at}>{formatTime(entry.at)}</time>
                        </td>
                        <td>{actorLabel(entry, me, names)}</td>
                        <td>
                          {actionLabel(entry.action)}
                          {entry.outcome === 'failure' ? (
                            <span className="tag danger plain">Failed</span>
                          ) : null}
                        </td>
                        <td className="sub small">{detailText(entry.detail)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {page.nextBefore !== null ? (
                <div className="mt-4">
                  <button
                    className="btn sm"
                    type="button"
                    disabled={busy}
                    onClick={() => void read(applied, page.nextBefore ?? undefined)}
                  >
                    Load older
                  </button>
                </div>
              ) : null}
            </>
          )
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>

      <section className="sec" aria-labelledby="h-chain">
        <div className="sec-head">
          <h2 id="h-chain">Chain check</h2>
          <p>
            Each entry carries the fingerprint of the one before it, and copies are kept outside the server
          </p>
        </div>
        <div className="panel pad stack">
          {verified ? (
            <VerifyResult result={verified} />
          ) : (
            <p className="sub small">
              Not checked from this screen yet. The check also runs every night after the export.
            </p>
          )}
          {verifyError ? (
            <p className="errtext" role="alert">
              {verifyError}
            </p>
          ) : null}
          <div>
            <button className="btn primary" type="button" disabled={verifying} onClick={() => void verify()}>
              Verify now
            </button>
          </div>
        </div>
      </section>
    </main>
  )
}
