import type { AuditEntry, AuditSink, MailMessage, Mailer } from './ports.ts'

export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = []
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message)
  }
}

export class MemoryAudit implements AuditSink {
  readonly entries: AuditEntry[] = []
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry)
  }
}
