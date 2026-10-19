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
  // Real-time limits (not the Clock): one send, and one timer tick. Defaults below.
  sendTimeoutMs?: number
  tickBudgetMs?: number
}

export const SEND_TIMEOUT_MS = 10_000
export const TICK_BUDGET_MS = 20_000
// An alert is given up on (kept undelivered, flagged stalled) after this many attempts.
export const ALERT_MAX_ATTEMPTS = 10

// True once a tick that began at `startedAt` (Date.now()) has used its budget: no new send is started.
export const overBudget = (deps: NotifyDeps, startedAt: number): boolean =>
  Date.now() - startedAt >= (deps.tickBudgetMs ?? TICK_BUDGET_MS)

// A send that does not answer in time fails with SendTimeout; the timer is always cleared. A real adapter
// must still enforce its own transport timeout, since this only stops waiting.
export async function withSendTimeout<T>(deps: NotifyDeps, send: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('send timed out'), { name: 'SendTimeout' })),
      deps.sendTimeoutMs ?? SEND_TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([send(), limit])
  } finally {
    clearTimeout(timer)
  }
}

// The name of an error and nothing else: a message can hold an address or a provider response.
export function errorName(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? `${error.name}:${code}` : error.name
  }
  return 'UnknownError'
}
