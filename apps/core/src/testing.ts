import type { AuditEntry, AuditSink, MailMessage, Mailer } from './ports.ts'

export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = []
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message)
  }
}

// A mail transport that is down: every send fails. Nothing is ever in `sent`.
export class ThrowingMailer implements Mailer {
  readonly sent: MailMessage[] = []
  attempts = 0
  async send(message: MailMessage): Promise<void> {
    void message // the message is refused unread
    this.attempts += 1
    throw new Error('mail transport is down')
  }
}

export class MemoryAudit implements AuditSink {
  readonly entries: AuditEntry[] = []
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry)
  }
}
