import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const TIMESTAMP_HEADER = 'x-mkt-timestamp'
export const NONCE_HEADER = 'x-mkt-nonce'
export const SIGNATURE_HEADER = 'x-mkt-signature'
// A request is accepted when its timestamp is within this many seconds of ours, either way (inclusive).
export const WINDOW_SECONDS = 300

// What is signed: METHOD, the path exactly as received, the timestamp, the nonce and the hash of the body bytes
// exactly as received, one per line.
export function signingText(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
): string {
  const bodyHash = createHash('sha256').update(body).digest('hex')
  return [method.toUpperCase(), path, timestamp, nonce, bodyHash].join('\n')
}

export function sign(secret: string, text: string): string {
  return createHmac('sha256', secret).update(text).digest('hex')
}

export type TriggerRefusal =
  'missing_header' | 'query_string' | 'bad_timestamp' | 'stale' | 'bad_nonce' | 'bad_signature' | 'replayed'
export type TriggerCheck = { ok: true } | { ok: false; reason: TriggerRefusal }

// Plain decimal seconds only: no sign, space, exponent, fraction or leading zero, and short enough to be exact.
const TIMESTAMP = /^(0|[1-9][0-9]{0,14})$/
const NONCE = /^[0-9a-f]{64}$/

const header = (headers: Record<string, unknown>, name: string): string | null => {
  const value = headers[name]
  return typeof value === 'string' && value !== '' ? value : null
}

// Order matters: nothing costly or stateful happens before the signature is proved. The nonce is recorded by
// the caller only after this returns ok, so a caller without the secret cannot fill the nonce table.
export function checkSignature(input: {
  secret: string
  method: string
  originalUrl: string
  headers: Record<string, unknown>
  rawBody: Buffer
  nowSeconds: number
}): TriggerCheck {
  const timestamp = header(input.headers, TIMESTAMP_HEADER)
  const nonce = header(input.headers, NONCE_HEADER)
  const given = header(input.headers, SIGNATURE_HEADER)
  if (timestamp === null || nonce === null || given === null) return { ok: false, reason: 'missing_header' }
  // The signed path is the one received; a query string is never part of a trigger, even an empty one.
  if (input.originalUrl.includes('?')) return { ok: false, reason: 'query_string' }
  if (!TIMESTAMP.test(timestamp)) return { ok: false, reason: 'bad_timestamp' }
  if (Math.abs(input.nowSeconds - Number(timestamp)) > WINDOW_SECONDS) return { ok: false, reason: 'stale' }
  if (!NONCE.test(nonce)) return { ok: false, reason: 'bad_nonce' }
  const expected = Buffer.from(
    sign(input.secret, signingText(input.method, input.originalUrl, timestamp, nonce, input.rawBody)),
  )
  const received = Buffer.from(given)
  // timingSafeEqual throws on unequal lengths, so the length is compared first (it is public: always 64).
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { ok: false, reason: 'bad_signature' }
  }
  return { ok: true }
}
