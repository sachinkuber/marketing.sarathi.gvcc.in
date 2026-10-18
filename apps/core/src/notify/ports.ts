import type { Pool } from '@mkt/db'
import type { Logger } from 'pino'
import type { AuditSink, Mailer, SendReceipt } from '../ports.ts'

export interface AlertMessage {
  subject: string
  text: string
}

// The second channel an alert goes out on besides email (a chat message or an SMS; the choice is owner item
// A11). A send that returns has been confirmed by the provider; one that cannot confirm throws.
export interface AlertChannel {
  send(message: AlertMessage): Promise<SendReceipt>
}

export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

// What delivery needs. `pool` is the application pool (the app role).
export interface NotifyDeps {
  pool: Pool
  mailer: Mailer
  channel: AlertChannel
  clock: Clock
  audit: AuditSink
  logger?: Pick<Logger, 'warn' | 'error'>
}

// The name of an error and nothing else: a message can hold an address or a provider response.
export function errorName(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? `${error.name}:${code}` : error.name
  }
  return 'UnknownError'
}
