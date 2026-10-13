import { createHmac, timingSafeEqual } from 'node:crypto'

export interface AttemptClaims {
  tokenId: string
  jobId: string
  brandId: string
  attemptId: string
  resultType: string
  issuedAt: number // seconds since the epoch
  expiresAt: number
}

export type TokenCheck =
  | { ok: true; claims: AttemptClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid' }

const VERSION = 'v1'
const FIELDS = ['tokenId', 'jobId', 'brandId', 'attemptId', 'resultType'] as const

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`${VERSION}.${payload}`).digest('base64url')
}

export function signAttemptToken(secret: string, claims: AttemptClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${VERSION}.${payload}.${sign(secret, payload)}`
}

export function verifyAttemptToken(secret: string, token: string, nowSeconds: number): TokenCheck {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2])
    return { ok: false, reason: 'malformed' }
  const [, payload, signature] = parts as [string, string, string]
  const expected = Buffer.from(sign(secret, payload))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return { ok: false, reason: 'bad_signature' }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  // A validly signed payload is still data: it must be an object with the seven fields of the right type.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed' }
  }
  const raw = parsed as Record<string, unknown>
  const strings = FIELDS.map((f) => raw[f])
  if (strings.some((v) => typeof v !== 'string' || v === '')) return { ok: false, reason: 'malformed' }
  const { issuedAt, expiresAt } = raw
  if (
    typeof issuedAt !== 'number' ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt)
  ) {
    return { ok: false, reason: 'malformed' }
  }
  const claims: AttemptClaims = {
    tokenId: raw.tokenId as string,
    jobId: raw.jobId as string,
    brandId: raw.brandId as string,
    attemptId: raw.attemptId as string,
    resultType: raw.resultType as string,
    issuedAt,
    expiresAt,
  }
  if (nowSeconds < claims.issuedAt) return { ok: false, reason: 'not_yet_valid' }
  if (nowSeconds >= claims.expiresAt) return { ok: false, reason: 'expired' }
  return { ok: true, claims }
}
