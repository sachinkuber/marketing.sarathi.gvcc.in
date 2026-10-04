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

// The audit log. The real implementation (hash chain) arrives with package 6.
export interface AuditSink {
  record(entry: AuditEntry): Promise<void>
}
