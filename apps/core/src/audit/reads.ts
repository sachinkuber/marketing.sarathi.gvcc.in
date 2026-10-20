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

// The entries of a chain whose subject is `subject` (audit.search has no subject filter), newest first. The
// scan is bounded: it stops after `maxScanned` entries, so a long chain costs a fixed amount.
export async function entriesAbout(
  reader: Pool,
  chainKey: string,
  subject: string,
  maxScanned = 5000,
): Promise<AuditEntryView[]> {
  const found: AuditEntryView[] = []
  let before: number | undefined
  let scanned = 0
  while (scanned < maxScanned) {
    const page = await searchAudit(reader, chainKey, { before }, 200)
    for (const entry of page.items) if (entry.subject === subject) found.push(entry)
    scanned += page.items.length
    if (page.nextBefore === null) break
    before = page.nextBefore
  }
  return found
}

export interface ChainVerification {
  ok: boolean
  findings: { kind: Finding['kind']; seq: number | null }[]
  lastExport: { throughSeq: number; exportedAt: string } | null
}

// The same two checks as the daily verify (audit/verify.ts) for one chain: the chain on its own, then every
// mark of an export against the log, the marks the database recorded and those the store holds. Without a
// store only the database's record can be compared.
export async function verifyChain(
  deps: { reader: Pool; store: ExportStore | null },
  chainKey: string,
): Promise<ChainVerification> {
  const findings: ChainVerification['findings'] = []
  const head = await deps.reader.query('select 1 from audit.chain_heads() where chain_key = $1', [chainKey])
  const stored = deps.store ? await deps.store.marks(chainKey) : []
  if (head.rowCount === 0) {
    if (stored.length > 0) findings.push({ kind: 'chain_missing', seq: null })
    return { ok: findings.length === 0, findings, lastExport: null }
  }
  const check = await deps.reader.query<{ ok: boolean; broken_at: string | null }>(
    'select ok, broken_at from audit.verify_chain($1)',
    [chainKey],
  )
  const row = check.rows[0]
  if (row && !row.ok) findings.push({ kind: 'broken_chain', seq: Number(row.broken_at) })

  const recorded = await deps.reader.query<{ through_seq: string; chain_hash: string; exported_at: Date }>(
    'select through_seq::text as through_seq, chain_hash, exported_at from audit.exports_for($1)',
    [chainKey],
  )
  const marks = [
    ...recorded.rows.map((m) => ({ throughSeq: Number(m.through_seq), chainHash: m.chain_hash })),
    ...stored.map((m) => ({ throughSeq: m.throughSeq, chainHash: m.chainHash })),
  ]
  const seen = new Set<string>()
  for (const mark of marks) {
    const at = await deps.reader.query<{ h: string | null }>('select audit.hash_at($1, $2) as h', [
      chainKey,
      String(mark.throughSeq),
    ])
    const hash = at.rows[0]?.h ?? null
    const kind =
      hash === null ? 'log_shorter_than_export' : hash !== mark.chainHash ? 'export_mismatch' : null
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
}
