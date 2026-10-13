import type { PoolClient } from '@mkt/db'

export interface MailMessage {
  to: string
  subject: string
  text: string
}

// Email delivery. The real implementation (Nodemailer) arrives with notification delivery, package 11.
export interface Mailer {
  send(message: MailMessage): Promise<void>
}

export interface AuditEntry {
  action: string
  actor: string | null
  subject?: string | null
  brandId?: string | null
  outcome: 'success' | 'failure'
  detail?: Record<string, unknown>
}

// The audit log (packages/db, audit.append). With `tx` the entry is written inside that transaction, so a
// change and its entry stand or fall together; without it the entry is written on its own.
export interface AuditSink {
  record(entry: AuditEntry, tx?: PoolClient): Promise<void>
}
