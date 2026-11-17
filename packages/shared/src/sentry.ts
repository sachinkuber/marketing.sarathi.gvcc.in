import * as Sentry from '@sentry/node'
import type { ErrorEvent } from '@sentry/node'

const EMAIL = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi
const SECRET_KEY = /secret|token|password|authorization|dsn|smtp/i
const KEEP_HEADERS = new Set(['content-type', 'user-agent'])
const URL_KEYS = new Set(['url', 'to', 'from'])
const MAX_DEPTH = 20

function scrubText(text: string): string {
  return text.replace(EMAIL, '[email]')
}

// A query string or fragment can carry personal data, so only the address up to it is kept.
function stripUrl(value: string): string {
  return value.split(/[?#]/, 1)[0]!
}

// Walks any value: strings lose email addresses, values under a secret-looking key are removed. `path`
// holds the objects being walked on the way down, so a shared (not circular) reference survives.
function scrubValue(value: unknown, path: Set<object>, depth: number): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (value === null || typeof value !== 'object') return value
  if (path.has(value)) return '[circular]'
  if (depth >= MAX_DEPTH) return '[too deep]'
  path.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => scrubValue(item, path, depth + 1))
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue
      out[key] = scrubValue(item, path, depth + 1)
    }
    return out
  } finally {
    path.delete(value)
  }
}

// Removes personal data and secrets from an error event before it leaves the process.
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  // Internal bookkeeping (it can hold scope and client objects); the SDK removes it before sending anyway.
  const rest = { ...event }
  delete rest.sdkProcessingMetadata
  const clean = scrubValue(rest, new Set(), 0) as ErrorEvent
  delete clean.user
  if (typeof clean.request?.url === 'string') clean.request.url = stripUrl(clean.request.url)
  for (const crumb of clean.breadcrumbs ?? []) {
    const data = crumb.data
    if (!data) continue
    for (const key of URL_KEYS) {
      if (typeof data[key] === 'string') data[key] = stripUrl(data[key])
    }
  }
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
