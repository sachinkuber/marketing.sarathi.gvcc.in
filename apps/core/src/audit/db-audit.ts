import type { Pool, PoolClient } from '@mkt/db'
import type { AuditEntry, AuditSink } from '../ports.ts'

// Writes through the database function audit.append. `standalone` is a pool that connects as the audit-writer
// role; it is used only for entries that belong to no business transaction. A person is the actor when the
// entry names one, and the system otherwise (for example a failed sign-in).
export class DbAudit implements AuditSink {
  private readonly standalone: Pool

  constructor(standalone: Pool) {
    this.standalone = standalone
  }

  async record(entry: AuditEntry, tx?: PoolClient): Promise<void> {
    const runner = tx ?? this.standalone
    await runner.query('select audit.append($1::uuid, $2::app.actor_kind, $3::uuid, $4, $5, $6, $7::jsonb)', [
      entry.brandId ?? null,
      entry.actorKind ?? (entry.actor ? 'user' : 'system'),
      entry.actor,
      entry.action,
      entry.outcome,
      entry.subject ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
    ])
  }
}
