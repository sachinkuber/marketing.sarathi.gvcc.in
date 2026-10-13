import type { MailMessage, Mailer } from './ports.ts'

// Stands in until notification delivery (package 11). No invite or recovery mail can be sent before then.
export class UnconfiguredMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    void message // delivery is not configured, so the message is never read
    throw new Error('Email delivery is not configured. It arrives with notification delivery (package 11).')
  }
}
