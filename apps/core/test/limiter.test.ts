import { describe, expect, it } from 'vitest'
import { AttemptLimiter, attemptKey } from '../src/auth/limiter.ts'

function make() {
  let now = 1_000_000
  const limiter = new AttemptLimiter({
    maxFailures: 5,
    windowMs: 15 * 60_000,
    lockMs: 15 * 60_000,
    now: () => now,
  })
  return { limiter, advance: (ms: number) => void (now += ms) }
}

describe('AttemptLimiter', () => {
  it('allows four failures and locks on the fifth', () => {
    const { limiter } = make()
    for (let i = 0; i < 4; i++) {
      limiter.fail('k')
      expect(limiter.check('k')).toBe(0)
    }
    limiter.fail('k')
    expect(limiter.check('k')).toBe(15 * 60_000)
  })

  it('counts down and frees the key when the lock ends', () => {
    const { limiter, advance } = make()
    for (let i = 0; i < 5; i++) limiter.fail('k')
    advance(10 * 60_000)
    expect(limiter.check('k')).toBe(5 * 60_000)
    advance(5 * 60_000)
    expect(limiter.check('k')).toBe(0)
    limiter.fail('k')
    expect(limiter.check('k')).toBe(0)
  })

  it('forgets failures older than the window', () => {
    const { limiter, advance } = make()
    for (let i = 0; i < 4; i++) limiter.fail('k')
    advance(16 * 60_000)
    limiter.fail('k')
    expect(limiter.check('k')).toBe(0)
  })

  it('clears a key on success and keeps keys apart', () => {
    const { limiter } = make()
    for (let i = 0; i < 4; i++) limiter.fail('a')
    limiter.succeed('a')
    limiter.fail('a')
    expect(limiter.check('a')).toBe(0)
    for (let i = 0; i < 5; i++) limiter.fail('b')
    expect(limiter.check('b')).toBeGreaterThan(0)
    expect(limiter.check('a')).toBe(0)
  })

  it('treats capitals and spaces in an email as the same key', () => {
    expect(attemptKey('/sign-in/email', '  Admin@Example.TEST ')).toBe(
      attemptKey('/sign-in/email', 'admin@example.test'),
    )
    expect(attemptKey('/sign-in/email', 'a@x')).not.toBe(attemptKey('/request-password-reset', 'a@x'))
  })
})
