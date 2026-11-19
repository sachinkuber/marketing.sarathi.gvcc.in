import type { MailMessage, Mailer, SendReceipt } from './ports.ts'

// Stands in until the real mail transport exists (owner item A11). No mail can be sent before then.
export class UnconfiguredMailer implements Mailer {
  async send(message: MailMessage): Promise<SendReceipt> {
    void message // delivery is not configured, so the message is never read
    throw new Error('Email delivery is not configured. The real transport is an owner item (A11).')
  }
}
