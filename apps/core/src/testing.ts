import type { PoolClient } from '@mkt/db'
import type { AuditEntry, AuditSink, MailMessage, Mailer, SendReceipt } from './ports.ts'

export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = []
  async send(message: MailMessage): Promise<SendReceipt> {
    this.sent.push(message)
    return { providerId: `memory-${this.sent.length}` }
  }
}

// A mail transport that is down: every send fails. Nothing is ever in `sent`.
export class ThrowingMailer implements Mailer {
  readonly sent: MailMessage[] = []
  attempts = 0
  async send(message: MailMessage): Promise<SendReceipt> {
    void message // the message is refused unread
    this.attempts += 1
    throw new Error('mail transport is down')
  }
}

// A mail transport that never answers (a hung server): every send stays pending for good.
export class HangingMailer implements Mailer {
  readonly sent: MailMessage[] = []
  attempts = 0
  send(message: MailMessage): Promise<SendReceipt> {
    void message // the message is never answered
    this.attempts += 1
    return new Promise<SendReceipt>(() => undefined)
  }
}

export class MemoryAudit implements AuditSink {
  readonly entries: AuditEntry[] = []
  // Parallel to entries: true where the call carried a transaction, so a test can see which entries were
  // written inside the change they record.
  readonly transactional: boolean[] = []
  async record(entry: AuditEntry, tx?: PoolClient): Promise<void> {
    this.entries.push(entry)
    this.transactional.push(tx !== undefined)
  }
}
