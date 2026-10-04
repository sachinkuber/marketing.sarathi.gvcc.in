import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { libraryLogger, createLogger } from '../src/logger.ts'
import type { AuditEntry } from '../src/ports.ts'
import { MemoryAudit } from '../src/testing.ts'
import { addUser, createStack, type Stack } from './support.ts'

const PASSWORD = 'correct horse battery'

// An audit sink that can be switched off, to make an auth route fail with an error that is not the
// library's own.
class SwitchableAudit extends MemoryAudit {
  down = false
  override async record(entry: AuditEntry): Promise<void> {
    if (this.down) throw new Error('audit sink is down')
    await super.record(entry)
  }
}

describe('the library logger, as wired in production', () => {
  it('writes through the service logger, keeps the message, and drops everything but an error name and message', () => {
    const lines: string[] = []
    const logger = libraryLogger(createLogger('debug', { write: (line: string) => void lines.push(line) }))
    const failure = Object.assign(new Error('insert failed'), {
      detail: 'Key (email)=(someone@example.test)',
    })
    logger.log?.('warn', 'User not found', { email: 'someone@example.test' })
    logger.log?.('error', 'Failed', failure)
    expect(lines).toHaveLength(2)
    const [warn, error] = lines.map((line) => JSON.parse(line))
    expect(warn).toMatchObject({ level: 40, msg: 'User not found', library: 'better-auth' })
    expect(error).toMatchObject({
      level: 50,
      msg: 'Failed',
      errors: [{ type: 'Error', message: 'insert failed' }],
    })
    expect(lines.join('\n')).not.toContain('someone@example.test')
    expect(lines.join('\n')).not.toContain('stack')
  })
})

describe('nothing from the library reaches the console', () => {
  let stack: Stack
  let audit: SwitchableAudit
  const spies = () => ['log', 'info', 'warn', 'error'].map((name) => vi.spyOn(console, name as 'log'))

  beforeAll(async () => {
    audit = new SwitchableAudit()
    stack = await createStack({ audit, libraryLog: true })
    await addUser(stack, { email: 'known@example.test', password: PASSWORD })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    audit.down = false
  })
  afterAll(async () => stack?.close())

  it('logs an unknown address on reset and sign-in through the service logger, without the address', async () => {
    const console = spies()
    const before = stack.logs.length
    await stack
      .newClient()
      .request('POST', '/api/auth/request-password-reset', { body: { email: 'nobody@example.test' } })
    await stack.newClient().signIn('nobody@example.test', PASSWORD)
    for (const spy of console) expect(spy).not.toHaveBeenCalled()
    const lines = stack.logs.slice(before)
    expect(lines.some((line) => line.includes('Reset Password: User not found'))).toBe(true)
    expect(lines.join('\n')).not.toContain('nobody@example.test')
  })

  it('answers 500 when the audit sink is down (fail-closed), and logs it through the service logger', async () => {
    const console = spies()
    const before = stack.logs.length
    audit.down = true
    const reply = await stack.newClient().signIn('known@example.test', PASSWORD)
    expect(reply.status).toBe(500)
    expect(reply.setCookies.some((line) => /session_token=[^;]+/.test(line))).toBe(false)
    for (const spy of console) expect(spy).not.toHaveBeenCalled()
    expect(stack.logs.slice(before).some((line) => line.includes('audit sink is down'))).toBe(true)
  })
})
