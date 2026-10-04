import { describe, expect, it } from 'vitest'
import { createLogger } from '../src/logger.ts'

function capture() {
  const lines: string[] = []
  return {
    lines,
    stream: {
      write: (line: string) => {
        lines.push(line)
      },
    },
  }
}

describe('logger redaction', () => {
  it('replaces secrets at the top level and one level down', () => {
    const { lines, stream } = capture()
    const log = createLogger('info', stream)
    log.info(
      {
        password: 'hunter2',
        body: { newPassword: 'hunter3', code: '123456', totpURI: 'otpauth://totp/x?secret=ABCDEF' },
        req: { headers: { cookie: 'sid=abc', authorization: 'Bearer t0k', 'x-csrf-token': 'csrf-value' } },
      },
      'a request',
    )
    const out = lines.join('')
    for (const secret of ['hunter2', 'hunter3', '123456', 'ABCDEF', 'sid=abc', 'Bearer t0k', 'csrf-value']) {
      expect(out).not.toContain(secret)
    }
    expect(out).toContain('[Redacted]')
  })

  it('keeps ordinary fields', () => {
    const { lines, stream } = capture()
    createLogger('info', stream).info({ route: '/health/live', status: 200 }, 'ok')
    expect(lines.join('')).toContain('/health/live')
  })
})
