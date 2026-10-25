import type { Pool } from '@mkt/db'
import type { ExportStore } from './store.ts'

export interface Finding {
  chainKey: string
  kind: 'broken_chain' | 'export_mismatch' | 'log_shorter_than_export' | 'chain_missing'
  seq?: number
  detail: string
}

// Checks every chain two ways. First on its own: the database recomputes each entry's hash and link. Then
// against the copies held outside the server, which a person with write access to the database cannot
// change: the log must still hold, at every exported point, the hash that was exported. The second check is
// what catches an entry altered together with its hash, a chain cut short, and a chain removed.
// With no store (none is configured yet) only the first check runs, over every chain in the log.
export async function verifyAudit(deps: {
  reader: Pool
  store: ExportStore | null
  onMismatch?: (findings: Finding[]) => Promise<void> | void
}): Promise<{ ok: boolean; chains: number; findings: Finding[] }> {
  const heads = await deps.reader.query('select chain_key from audit.chain_heads()')
  const live = new Set((heads.rows as { chain_key: string }[]).map((r) => r.chain_key))
  const keys = new Set([...live, ...(deps.store ? await deps.store.chainKeys() : [])])
  const findings: Finding[] = []

  for (const chainKey of [...keys].sort()) {
    if (!live.has(chainKey)) {
      findings.push({
        chainKey,
        kind: 'chain_missing',
        detail: 'the store holds this chain and the log does not',
      })
      continue
    }
    const check = await deps.reader.query('select * from audit.verify_chain($1)', [chainKey])
    const row = check.rows[0] as { ok: boolean; broken_at: string | null }
    if (!row.ok) {
      findings.push({
        chainKey,
        kind: 'broken_chain',
        seq: Number(row.broken_at),
        detail: 'the chain does not check out at this entry',
      })
    }
    for (const mark of deps.store ? await deps.store.marks(chainKey) : []) {
      const at = await deps.reader.query('select audit.hash_at($1, $2) as h', [chainKey, mark.throughSeq])
      const hash = (at.rows[0] as { h: string | null }).h
      if (hash === null) {
        findings.push({
          chainKey,
          kind: 'log_shorter_than_export',
          seq: mark.throughSeq,
          detail: 'the log has no entry where the store has one',
        })
      } else if (hash !== mark.chainHash) {
        findings.push({
          chainKey,
          kind: 'export_mismatch',
          seq: mark.throughSeq,
          detail: 'the entry differs from the copy outside the server',
        })
      }
    }
  }

  if (findings.length > 0) await deps.onMismatch?.(findings)
  return { ok: findings.length === 0, chains: keys.size, findings }
}
