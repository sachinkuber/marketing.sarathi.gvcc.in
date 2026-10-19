import type { MailMessage, Mailer, SendReceipt } from '../ports.ts'
import type { AlertChannel, AlertMessage } from './ports.ts'

// In-memory stand-ins for tests only. Each can be told to fail the next N sends, and returns a provider id
// the way a real provider's confirmation would.
abstract class Flaky<M> {
  readonly sent: M[] = []
  attempts = 0
  private failures = 0
  protected abstract readonly prefix: string

  failNext(times: number): void {
    this.failures = times
  }

  // `confirm: false` makes the double answer without a provider id, as a transport that cannot confirm.
  confirm = true

  // When true, a send never answers (a hung transport).
  hang = false

  protected async take(message: M): Promise<SendReceipt> {
    this.attempts += 1
    if (this.hang) return new Promise<SendReceipt>(() => undefined)
    if (this.failures > 0) {
      this.failures -= 1
      throw new Error('transport down')
    }
    this.sent.push(message)
    return { providerId: this.confirm ? `${this.prefix}-${this.sent.length}` : '' }
  }
}

export class DoubleMailer extends Flaky<MailMessage> implements Mailer {
  protected readonly prefix = 'mail'
  send(message: MailMessage): Promise<SendReceipt> {
    return this.take(message)
  }
}

export class DoubleAlertChannel extends Flaky<AlertMessage> implements AlertChannel {
  protected readonly prefix = 'chan'
  send(message: AlertMessage): Promise<SendReceipt> {
    return this.take(message)
  }
}

// A clock a test moves by hand.
export class ManualClock {
  constructor(private at: Date) {}
  now(): Date {
    return new Date(this.at)
  }
  advance(ms: number): void {
    this.at = new Date(this.at.getTime() + ms)
  }
}
