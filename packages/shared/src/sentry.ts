import * as Sentry from '@sentry/node'
import type { ErrorEvent } from '@sentry/node'

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const SECRET_KEY = /secret|token|password|authorization|dsn|smtp/i
const KEEP_HEADERS = new Set(['content-type', 'user-agent'])

function scrubText(text: string): string {
  return text.replace(EMAIL, '[email]')
}

// Walks any value: strings lose email addresses, values under a secret-looking key are removed.
function scrubValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, seen))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue
    out[key] = scrubValue(item, seen)
  }
  return out
}

// Removes personal data and secrets from an error event before it leaves the process.
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const clean = scrubValue(event, new WeakSet()) as ErrorEvent
  delete clean.user
  if (clean.request) {
    const { headers, ...rest } = clean.request
    delete rest.data
    delete rest.cookies
    delete rest.query_string
    const kept: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (KEEP_HEADERS.has(name.toLowerCase())) kept[name] = value
    }
    clean.request = { ...rest, ...(headers ? { headers: kept } : {}) }
  }
  return clean
}

// Returns false and does nothing when no DSN is configured.
export function initErrorTracking(opts: {
  dsn?: string
  service: 'core' | 'worker'
  release: string
}): boolean {
  if (!opts.dsn) return false
  Sentry.init({
    dsn: opts.dsn,
    release: opts.release,
    serverName: opts.service,
    initialScope: { tags: { service: opts.service } },
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
    beforeSendTransaction: () => null,
  })
  return true
}

// Reports an error that was handled by the caller's own log line. A no-op until initErrorTracking ran.
export function captureError(error: unknown): void {
  Sentry.captureException(error)
}
