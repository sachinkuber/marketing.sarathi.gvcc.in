import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

const base = {
  DATABASE_URL: 'postgres://app:pw@127.0.0.1:5432/mkt',
  AUDIT_DATABASE_URL: 'postgres://audit:pw@127.0.0.1:5432/mkt',
  QUEUE_DATABASE_URL: 'postgres://queue:pw@127.0.0.1:5432/mkt',
  AUTH_SECRET: 'a'.repeat(32),
  WORKER_SECRET: 'w'.repeat(32),
  ATTEMPT_TOKEN_SECRET: 't'.repeat(32),
  TRIGGER_SECRET: 'g'.repeat(32),
  PUBLIC_ORIGIN: 'https://app.example.test',
}

describe('loadConfig', () => {
  it('applies defaults and ignores unrelated variables', () => {
    const config = loadConfig({ ...base, PATH: '/usr/bin', HOME: '/root' })
    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 4000,
      logLevel: 'info',
      publicOrigin: 'https://app.example.test',
      queueDatabaseUrl: base.QUEUE_DATABASE_URL,
      workerSecret: base.WORKER_SECRET,
      triggerSecret: base.TRIGGER_SECRET,
      attemptTokenSecret: base.ATTEMPT_TOKEN_SECRET,
      queueBacklogLimit: 2000,
    })
  })

  it('reads the backlog limit when it is set', () => {
    expect(loadConfig({ ...base, QUEUE_BACKLOG_LIMIT: '50' }).queueBacklogLimit).toBe(50)
  })

  it('refuses secrets that are equal, without printing them', () => {
    const same = 's'.repeat(32)
    for (const env of [
      { ...base, WORKER_SECRET: same, ATTEMPT_TOKEN_SECRET: same },
      { ...base, WORKER_SECRET: base.AUTH_SECRET },
      { ...base, ATTEMPT_TOKEN_SECRET: base.AUTH_SECRET },
      { ...base, TRIGGER_SECRET: base.AUTH_SECRET },
      { ...base, TRIGGER_SECRET: base.WORKER_SECRET },
      { ...base, TRIGGER_SECRET: base.ATTEMPT_TOKEN_SECRET },
    ]) {
      expect(() => loadConfig(env)).toThrow('Invalid configuration: secrets must differ')
      expect(() => loadConfig(env)).not.toThrow(same)
    }
  })

  it('names only the missing queue variables', () => {
    const rest: Record<string, string> = { ...base }
    delete rest.WORKER_SECRET
    let message = ''
    try {
      loadConfig(rest)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toBe('Invalid configuration: WORKER_SECRET')
  })

  it('requires a trigger secret of at least 32 characters, naming only the variable', () => {
    const missing: Record<string, string> = { ...base }
    delete missing.TRIGGER_SECRET
    expect(() => loadConfig(missing)).toThrow('Invalid configuration: TRIGGER_SECRET')
    expect(() => loadConfig({ ...base, TRIGGER_SECRET: 'short' })).toThrow(
      'Invalid configuration: TRIGGER_SECRET',
    )
  })

  it('reduces the public origin to scheme, host and port', () => {
    const config = loadConfig({ ...base, PUBLIC_ORIGIN: 'https://app.example.test/some/path/' })
    expect(config.publicOrigin).toBe('https://app.example.test')
  })

  it('names every bad variable and prints no value', () => {
    const secret = 'short-secret'
    let message = ''
    try {
      loadConfig({ AUTH_SECRET: secret, PUBLIC_ORIGIN: 'not a url' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('DATABASE_URL')
    expect(message).toContain('AUDIT_DATABASE_URL')
    expect(message).toContain('AUTH_SECRET')
    expect(message).toContain('PUBLIC_ORIGIN')
    expect(message).not.toContain(secret)
  })
})
