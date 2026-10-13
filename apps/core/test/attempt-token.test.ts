import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signAttemptToken, verifyAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'

const SECRET = 'attempt-secret-'.padEnd(48, 'x')
const claims = (): AttemptClaims => ({
  tokenId: randomUUID(),
  jobId: randomUUID(),
  brandId: randomUUID(),
  attemptId: randomUUID(),
  resultType: 'test.echo',
  issuedAt: 1_000,
  expiresAt: 2_000,
})

describe('the attempt token (acceptance test 32, token half)', () => {
  it('verifies a token inside its times and returns its claims', () => {
    const c = claims()
    const result = verifyAttemptToken(SECRET, signAttemptToken(SECRET, c), 1_500)
    expect(result).toEqual({ ok: true, claims: c })
  })

  it('refuses an expired token and one not yet valid', () => {
    const token = signAttemptToken(SECRET, claims())
    expect(verifyAttemptToken(SECRET, token, 2_000)).toEqual({ ok: false, reason: 'expired' })
    expect(verifyAttemptToken(SECRET, token, 999)).toEqual({ ok: false, reason: 'not_yet_valid' })
  })

  it('refuses a token signed with another secret', () => {
    const token = signAttemptToken('another-secret-'.padEnd(48, 'y'), claims())
    expect(verifyAttemptToken(SECRET, token, 1_500)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('refuses a token with any field changed', () => {
    const token = signAttemptToken(SECRET, claims())
    const [version, payload, signature] = token.split('.') as [string, string, string]
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    for (const field of ['jobId', 'brandId', 'attemptId', 'resultType', 'tokenId', 'expiresAt']) {
      const changed = { ...decoded, [field]: field === 'expiresAt' ? 9_999_999 : randomUUID() }
      const forged = [version, Buffer.from(JSON.stringify(changed)).toString('base64url'), signature].join(
        '.',
      )
      expect(verifyAttemptToken(SECRET, forged, 1_500)).toEqual({ ok: false, reason: 'bad_signature' })
    }
  })

  it('refuses things that are not tokens', () => {
    for (const text of ['', 'abc', 'v1.a', 'v2.a.b', 'v1..', 'v1.!!!.???']) {
      expect(verifyAttemptToken(SECRET, text, 1_500)).toMatchObject({ ok: false })
    }
  })
})
