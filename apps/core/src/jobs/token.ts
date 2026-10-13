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
  let claims: AttemptClaims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AttemptClaims
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const complete =
    FIELDS.every((f) => typeof claims[f] === 'string') &&
    typeof claims.issuedAt === 'number' &&
    typeof claims.expiresAt === 'number'
  if (!complete) return { ok: false, reason: 'malformed' }
  if (nowSeconds < claims.issuedAt) return { ok: false, reason: 'not_yet_valid' }
  if (nowSeconds >= claims.expiresAt) return { ok: false, reason: 'expired' }
  return { ok: true, claims }
}
