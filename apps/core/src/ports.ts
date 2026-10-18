import type { PoolClient } from '@mkt/db'

export interface MailMessage {
  to: string
  subject: string
  text: string
}

// The provider's confirmation that it took a message.
export interface SendReceipt {
  providerId: string
}

// Email delivery. The real implementation (Nodemailer) is an owner item (A11). A send that returns has been
// confirmed by the provider; one that cannot confirm throws.
export interface Mailer {
  send(message: MailMessage): Promise<SendReceipt>
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
