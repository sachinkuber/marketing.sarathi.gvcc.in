import type { Pool } from '@mkt/db'
import type { ExportStore } from './store.ts'
import type { Finding } from './verify.ts'

export interface AuditFilters {
  actor?: string
  action?: string
  from?: string
  to?: string
  before?: number
}

export interface AuditEntryView {
  seq: number
  at: string
  actorKind: string
  actorId: string | null
  action: string
  outcome: string
  subject: string | null
  detail: unknown
  hash: string
}

export const AUDIT_PAGE = 50

interface SearchRow {
  seq: string
  at: string
  actor_kind: string
  actor_id: string | null
  action: string
  outcome: string
  subject: string | null
  detail: unknown
  hash: string
}

const toView = (r: SearchRow): AuditEntryView => ({
  seq: Number(r.seq),
  at: r.at,
  actorKind: r.actor_kind,
  actorId: r.actor_id,
  action: r.action,
  outcome: r.outcome,
  subject: r.subject,
  detail: r.detail,
  hash: r.hash,
})

// One page of one chain, newest first, through audit.search (the owner-view role's function). `at` is the
// database's own text, to the microsecond, as the export carries it.
export async function searchAudit(
  reader: Pool,
  chainKey: string,
  filters: AuditFilters,
  limit = AUDIT_PAGE,
): Promise<{ items: AuditEntryView[]; nextBefore: number | null }> {
  const { rows } = await reader.query<SearchRow>(
    `select l.seq::text as seq, audit.at_text(l.at) as at, l.actor_kind::text as actor_kind, l.actor_id,
            l.action, l.outcome, l.subject, l.detail, l.hash
       from audit.search($1, $2::uuid, $3, $4::timestamptz, $5::timestamptz, $6::bigint, $7) l`,
    [
      chainKey,
      filters.actor ?? null,
      filters.action ?? null,
      filters.from ?? null,
      filters.to ?? null,
      filters.before === undefined ? null : String(filters.before),
      limit + 1,
    ],
  )
  const items = rows.slice(0, limit).map(toView)
  const more = rows.length > limit
  return { items, nextBefore: more ? (items[items.length - 1]?.seq ?? null) : null }
}

// audit.search returns at most this many rows a page, whatever is asked.
export const SEARCH_CAP = 200
export const SCAN_CAP = 5000

// The entries of a chain whose subject is `subject` (audit.search has no subject filter), newest first. The
// chain is read a full page at a time, continuing with before_seq, until it is exhausted, until a page reaches
// back before the run began (`notBefore`), or until SCAN_CAP entries have been scanned. `truncated` is true
// only when the cap stopped the scan with older entries possibly left unread.
export async function entriesAbout(
  reader: Pool,
  chainKey: string,
  subject: string,
  notBefore: Date,
  maxScanned = SCAN_CAP,
): Promise<{ entries: AuditEntryView[]; truncated: boolean }> {
  const found: AuditEntryView[] = []
  // An hour of slack for clocks and for entries written about a run just before its row.
  const floor = notBefore.getTime() - 3_600_000
  let before: number | null = null
  let scanned = 0
  for (;;) {
    const result: { rows: SearchRow[] } = await reader.query<SearchRow>(
      `select l.seq::text as seq, audit.at_text(l.at) as at, l.actor_kind::text as actor_kind, l.actor_id,
              l.action, l.outcome, l.subject, l.detail, l.hash
         from audit.search($1, null, null, null, null, $2::bigint, $3) l`,
      [chainKey, before === null ? null : String(before), SEARCH_CAP],
    )
    const page: AuditEntryView[] = result.rows.map(toView)
    for (const entry of page) if (entry.subject === subject) found.push(entry)
    scanned += page.length
    const last: AuditEntryView | undefined = page[page.length - 1]
    // A short page is the end of the chain.
    if (!last || page.length < SEARCH_CAP) return { entries: found, truncated: false }
    if (Date.parse(last.at) < floor) return { entries: found, truncated: false }
    if (scanned >= maxScanned) return { entries: found, truncated: true }
    before = last.seq
  }
}

export interface ChainVerification {
  ok: boolean
  findings: { kind: Finding['kind']; seq: number | null }[]
  lastExport: { throughSeq: number; exportedAt: string } | null
}

export class VerifyTimeout extends Error {
  constructor() {
    super('the audit check ran past its time limit')
    this.name = 'VerifyTimeout'
  }
}

export const VERIFY_TIMEOUT_MS = 30_000

// The same two checks as the daily verify (audit/verify.ts) for one chain: the chain on its own, then every
// mark of an export against the log, the marks the database recorded and those the store holds. Without a
// store only the database's record can be compared.
//
// Only the asked-for chain is touched (audit.verify_chain, audit.exports_for and audit.hash_at take the chain
// key; audit.chain_heads would scan every chain and is not used). The database work runs in one transaction
// with a statement timeout, so one slow check cannot hold the shared database.
export async function verifyChain(
  deps: { reader: Pool; store: ExportStore | null; timeoutMs?: number },
  chainKey: string,
): Promise<ChainVerification> {
  const stored = deps.store ? await deps.store.marks(chainKey) : []
  const client = await deps.reader.connect()
  try {
    await client.query('begin')
    await client.query(`select set_config('statement_timeout', $1, true)`, [
      String(deps.timeoutMs ?? VERIFY_TIMEOUT_MS),
    ])
    const findings: ChainVerification['findings'] = []
    const check = await client.query<{ ok: boolean; checked: string; broken_at: string | null }>(
      'select ok, checked::text as checked, broken_at::text as broken_at from audit.verify_chain($1)',
      [chainKey],
    )
    const row = check.rows[0]
    const empty = row !== undefined && row.ok && Number(row.checked) === 0
    if (empty && stored.length > 0) findings.push({ kind: 'chain_missing', seq: null })
    if (row && !row.ok) findings.push({ kind: 'broken_chain', seq: Number(row.broken_at) })

    const recorded = await client.query<{
      through_seq: string
      chain_hash: string
      exported_at: Date
      h: string | null
    }>(
      `select e.through_seq::text as through_seq, e.chain_hash, e.exported_at, audit.hash_at($1, e.through_seq) as h
         from audit.exports_for($1) e order by e.through_seq`,
      [chainKey],
    )
    const marks = recorded.rows.map((m) => ({
      throughSeq: Number(m.through_seq),
      chainHash: m.chain_hash,
      hash: m.h,
    }))
    if (stored.length > 0) {
      const hashes = await client.query<{ seq: string; h: string | null }>(
        'select s.seq::text as seq, audit.hash_at($1, s.seq) as h from unnest($2::bigint[]) as s(seq)',
        [chainKey, stored.map((m) => String(m.throughSeq))],
      )
      const byseq = new Map(hashes.rows.map((r) => [Number(r.seq), r.h]))
      for (const m of stored) {
        marks.push({
          throughSeq: m.throughSeq,
          chainHash: m.chainHash,
          hash: byseq.get(m.throughSeq) ?? null,
        })
      }
    }
    await client.query('commit')

    const seen = new Set<string>()
    for (const mark of marks) {
      const kind =
        mark.hash === null
          ? 'log_shorter_than_export'
          : mark.hash !== mark.chainHash
            ? 'export_mismatch'
            : null
      if (kind && !seen.has(`${kind}:${mark.throughSeq}`)) {
        seen.add(`${kind}:${mark.throughSeq}`)
        findings.push({ kind, seq: mark.throughSeq })
      }
    }
    const last = recorded.rows[recorded.rows.length - 1]
    return {
      ok: findings.length === 0,
      findings,
      lastExport: last
        ? { throughSeq: Number(last.through_seq), exportedAt: last.exported_at.toISOString() }
        : null,
    }
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    // 57014: query_canceled, which is what statement_timeout raises.
    if ((error as { code?: string }).code === '57014') throw new VerifyTimeout()
    throw error
  } finally {
    client.release()
  }
}
