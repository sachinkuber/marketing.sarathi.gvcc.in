import type { AlertChannel, AlertMessage } from './notify/ports.ts'
import type { MailMessage, Mailer, SendReceipt } from './ports.ts'

// Stands in until the real mail transport exists (owner item A11). No mail can be sent before then.
export class UnconfiguredMailer implements Mailer {
  async send(message: MailMessage): Promise<SendReceipt> {
    void message // delivery is not configured, so the message is never read
    throw new Error('Email delivery is not configured. The real transport is an owner item (A11).')
  }
}

// Stands in for the second alert channel until it is chosen (owner item A11). It always throws, so an alert
// raised in production stays undelivered, which is the loud outcome, rather than being reported as delivered.
export class UnconfiguredAlertChannel implements AlertChannel {
  async send(message: AlertMessage): Promise<SendReceipt> {
    void message // delivery is not configured, so the message is never read
    throw new Error('The alert channel is not configured. The real channel is an owner item (A11).')
  }
}
