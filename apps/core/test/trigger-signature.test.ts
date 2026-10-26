import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { KEEP_SECONDS } from '../src/triggers/nonce.ts'
import { WINDOW_SECONDS, checkSignature, sign, signingText } from '../src/triggers/signature.ts'

const SECRET = 'throwaway-trigger-secret-for-tests-only'
const NOW = 1_800_000_000
const NONCE = 'ab'.repeat(32)
const URL_PATH = '/api/v1/triggers/ping'
const BODY = Buffer.from('{"workflow":"daily"}')

function request(over: {
  timestamp?: string
  nonce?: string
  signature?: string
  url?: string
  body?: Buffer
}) {
  const timestamp = over.timestamp ?? String(NOW)
  const nonce = over.nonce ?? NONCE
  const url = over.url ?? URL_PATH
  const body = over.body ?? BODY
  const signature = over.signature ?? sign(SECRET, signingText('POST', url, timestamp, nonce, body))
  return {
    secret: SECRET,
    method: 'POST',
    originalUrl: url,
    headers: { 'x-mkt-timestamp': timestamp, 'x-mkt-nonce': nonce, 'x-mkt-signature': signature } as Record<
      string,
      unknown
    >,
    rawBody: body,
    nowSeconds: NOW,
  }
}

describe('signingText and sign', () => {
  it('is METHOD, path, timestamp, nonce and the hex sha256 of the body, one per line', () => {
    const hash = createHash('sha256').update(BODY).digest('hex')
    expect(signingText('post', URL_PATH, '12', NONCE, BODY)).toBe(
      ['POST', URL_PATH, '12', NONCE, hash].join('\n'),
    )
  })

  it('signs with HMAC-SHA256 as lowercase hex', () => {
    expect(sign('k', 'text')).toBe(createHmac('sha256', 'k').update('text').digest('hex'))
  })
})

describe('checkSignature', () => {
  it('accepts a correct request', () => {
    expect(checkSignature(request({}))).toEqual({ ok: true })
  })

  it('accepts a timestamp exactly 300 seconds old or ahead, and refuses 301', () => {
    for (const offset of [-300, 300]) {
      expect(checkSignature(request({ timestamp: String(NOW + offset) }))).toEqual({ ok: true })
    }
    for (const offset of [-301, 301]) {
      expect(checkSignature(request({ timestamp: String(NOW + offset) }))).toEqual({
        ok: false,
        reason: 'stale',
      })
    }
  })

  it('refuses a timestamp that is not plain decimal seconds', () => {
    for (const timestamp of ['1e3', ' 12', '12 ', '+12', '-12', '1.5', '0x10', '12\n', '9'.repeat(40)]) {
      expect(checkSignature(request({ timestamp }))).toEqual({ ok: false, reason: 'bad_timestamp' })
    }
  })

  it('refuses a nonce that is not 64 lowercase hex characters', () => {
    for (const nonce of ['ab'.repeat(31) + 'a', 'ab'.repeat(33), 'AB'.repeat(32), 'zz'.repeat(32)]) {
      expect(checkSignature(request({ nonce }))).toEqual({ ok: false, reason: 'bad_nonce' })
    }
  })

  it('refuses any query string, even a bare question mark', () => {
    for (const url of [`${URL_PATH}?a=1`, `${URL_PATH}?`]) {
      expect(checkSignature(request({ url }))).toEqual({ ok: false, reason: 'query_string' })
    }
  })

  it('refuses a missing header, each in turn', () => {
    for (const name of ['x-mkt-timestamp', 'x-mkt-nonce', 'x-mkt-signature']) {
      const input = request({})
      delete input.headers[name]
      expect(checkSignature(input)).toEqual({ ok: false, reason: 'missing_header' })
    }
  })

  it('answers bad_signature, and does not throw, for a signature of the wrong length', () => {
    for (const signature of ['ab', 'a'.repeat(63), 'a'.repeat(65), 'é'.repeat(32)]) {
      expect(checkSignature(request({ signature }))).toEqual({ ok: false, reason: 'bad_signature' })
    }
  })

  it('refuses a changed body, path, method and secret', () => {
    const good = request({})
    expect(checkSignature({ ...good, rawBody: Buffer.from('{"workflow":"daily" }') })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
    expect(checkSignature({ ...good, originalUrl: `${URL_PATH}/` })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
    expect(checkSignature({ ...good, method: 'PUT' })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(checkSignature({ ...good, secret: SECRET + 'x' })).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('checks in order: headers, query string, timestamp format, stale, nonce, signature', () => {
    const bad = request({ url: `${URL_PATH}?x`, timestamp: 'x', nonce: 'x', signature: 'x' })
    expect(checkSignature(bad)).toEqual({ ok: false, reason: 'query_string' })
    expect(checkSignature(request({ timestamp: 'x', nonce: 'x', signature: 'x' }))).toEqual({
      ok: false,
      reason: 'bad_timestamp',
    })
    expect(checkSignature(request({ timestamp: String(NOW - 999), nonce: 'x', signature: 'x' }))).toEqual({
      ok: false,
      reason: 'stale',
    })
    expect(checkSignature(request({ nonce: 'x', signature: 'x' }))).toEqual({
      ok: false,
      reason: 'bad_nonce',
    })
  })
})

describe('nonce retention', () => {
  it('outlasts the longest time a signed request stays acceptable, with a margin of a minute', () => {
    // A request is acceptable for 2 x the window (ts up to a window ahead, then a window behind), plus the
    // second lost to flooring the clock; the extra 60 s covers latency and clock skew.
    expect(KEEP_SECONDS).toBeGreaterThanOrEqual(2 * WINDOW_SECONDS + 60)
  })
})
