import type { Logger } from 'pino'
import type { AuditEntry, AuditSink, MailMessage, Mailer } from './ports.ts'

// Stands in until notification delivery (package 11). No invite or recovery mail can be sent before then.
export class UnconfiguredMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    void message // delivery is not configured, so the message is never read
    throw new Error('Email delivery is not configured. It arrives with notification delivery (package 11).')
  }
}

// Stands in until the audit log (package 6). Entries hold a hash of an address, never the address.
export class LogAudit implements AuditSink {
  private readonly logger: Logger

  constructor(logger: Logger) {
    this.logger = logger
  }

  async record(entry: AuditEntry): Promise<void> {
    this.logger.info({ audit: entry }, 'audit')
  }
}
