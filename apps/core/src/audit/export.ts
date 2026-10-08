import type { Pool } from '@mkt/db'
import type { ExportStore, ExportedRow } from './store.ts'

// Copies what is new in each chain to the store, then records that it did (audit.record_export checks the
// record against the log). The store is written first: if the run stops between the two, the next run puts
// the same batch again (a no-op in a write-once store) and records it.
export async function exportAudit(deps: {
  reader: Pool
  writer: Pool
  store: ExportStore
  batchSize?: number
}): Promise<{ chains: number; batches: number; entries: number }> {
  const batchSize = deps.batchSize ?? 1000
  const heads = await deps.reader.query(
    'select chain_key, head_seq from audit.chain_heads() order by chain_key',
  )
  let batches = 0
  let entries = 0
  for (const head of heads.rows as { chain_key: string; head_seq: string }[]) {
    const headSeq = Number(head.head_seq)
    const recorded = await deps.reader.query(
      'select coalesce(max(through_seq), 0) as n from audit.exports_for($1)',
      [head.chain_key],
    )
    // Start from the last point the database has recorded. A batch the store already holds but the database
    // never recorded is put again below (a no-op in a write-once store) and then recorded.
    let from = Number((recorded.rows[0] as { n: string }).n)
    while (from < headSeq) {
      const page = await deps.reader.query('select * from audit.entries_after($1, $2, $3)', [
        head.chain_key,
        from,
        batchSize,
      ])
      const rows = page.rows as Record<string, unknown>[]
      if (rows.length === 0) break
      const last = rows[rows.length - 1]!
      const throughSeq = Number(last.seq)
      const batch = {
        chainKey: head.chain_key,
        fromSeq: from + 1,
        throughSeq,
        headHash: last.hash as string,
        entries: rows.map(toRow),
      }
      const location = await deps.store.put(batch)
      await deps.writer.query('select audit.record_export($1, $2, $3, $4)', [
        head.chain_key,
        throughSeq,
        batch.headHash,
        location,
      ])
      batches += 1
      entries += rows.length
      from = throughSeq
    }
  }
  return { chains: heads.rows.length, batches, entries }
}

// `at` is for reading only, to the millisecond: node-pg drops the microseconds the entry hash covers.
function toRow(row: Record<string, unknown>): ExportedRow {
  return {
    seq: Number(row.seq),
    at: (row.at as Date).toISOString(),
    actor_kind: row.actor_kind as string,
    actor_id: (row.actor_id as string | null) ?? null,
    action: row.action as string,
    outcome: row.outcome as string,
    subject: (row.subject as string | null) ?? null,
    detail: row.detail ?? null,
    prev_hash: (row.prev_hash as string | null) ?? null,
    hash: row.hash as string,
  }
}
