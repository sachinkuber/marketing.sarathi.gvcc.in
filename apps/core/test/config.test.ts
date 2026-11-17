import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

const base = {
  DATABASE_URL: 'postgres://app:pw@127.0.0.1:5432/mkt',
  AUDIT_DATABASE_URL: 'postgres://audit:pw@127.0.0.1:5432/mkt',
  QUEUE_DATABASE_URL: 'postgres://queue:pw@127.0.0.1:5432/mkt',
  OWNER_VIEW_DATABASE_URL: 'postgres://owner:pw@127.0.0.1:5432/mkt',
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
      ownerViewDatabaseUrl: base.OWNER_VIEW_DATABASE_URL,
      n8nHeartbeatExpected: false,
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

  it('requires the owner-view database url, naming only the variable', () => {
    const missing: Record<string, string> = { ...base }
    delete missing.OWNER_VIEW_DATABASE_URL
    expect(() => loadConfig(missing)).toThrow('Invalid configuration: OWNER_VIEW_DATABASE_URL')
    expect(() => loadConfig({ ...base, OWNER_VIEW_DATABASE_URL: 'nope' })).toThrow(
      'Invalid configuration: OWNER_VIEW_DATABASE_URL',
    )
  })

  it('reads the heartbeat expectation as a strict boolean, false by default', () => {
    expect(loadConfig({ ...base, N8N_HEARTBEAT_EXPECTED: 'true' }).n8nHeartbeatExpected).toBe(true)
    expect(loadConfig({ ...base, N8N_HEARTBEAT_EXPECTED: 'false' }).n8nHeartbeatExpected).toBe(false)
    expect(() => loadConfig({ ...base, N8N_HEARTBEAT_EXPECTED: 'yes' })).toThrow(
      'Invalid configuration: N8N_HEARTBEAT_EXPECTED',
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

const production = {
  ...base,
  NODE_ENV: 'production',
  TRUST_PROXY: '1',
}

describe('production refusals', () => {
  it('refuses CHANGE_ME in any value when NODE_ENV=production, naming the variable and not the value', () => {
    for (const key of Object.keys(production).filter((k) => k !== 'NODE_ENV' && k !== 'TRUST_PROXY')) {
      const value = `${'z'.repeat(40)}CHANGE_ME`
      const env: Record<string, string> = { ...production }
      env[key] = key.endsWith('_URL') || key === 'PUBLIC_ORIGIN' ? `https://u:${value}@host.test/x` : value
      let message = ''
      try {
        loadConfig(env)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain(key)
      expect(message).not.toContain('CHANGE_ME')
      expect(message).not.toContain('zzzz')
    }
  })

  it('applies the CHANGE_ME refusal to a variable outside the base set, such as the Sentry DSN', () => {
    expect(() =>
      loadConfig({ ...production, SENTRY_DSN: 'https://CHANGE_ME@o0.ingest.example.test/1' }),
    ).toThrow('SENTRY_DSN')
  })

  it('refuses an http PUBLIC_ORIGIN in production', () => {
    expect(() => loadConfig({ ...production, PUBLIC_ORIGIN: 'http://app.example.test' })).toThrow(
      'Invalid configuration: PUBLIC_ORIGIN',
    )
  })

  it('requires TRUST_PROXY in production', () => {
    const rest: Record<string, string> = { ...production }
    delete rest.TRUST_PROXY
    expect(() => loadConfig(rest)).toThrow('Invalid configuration: TRUST_PROXY')
  })

  it('reads TRUST_PROXY as an integer from 0 to 3', () => {
    expect(loadConfig({ ...production, TRUST_PROXY: '0' }).trustProxy).toBe(0)
    expect(loadConfig({ ...production, TRUST_PROXY: '3' }).trustProxy).toBe(3)
    for (const bad of ['4', '-1', '1.5', 'yes', '']) {
      expect(() => loadConfig({ ...production, TRUST_PROXY: bad })).toThrow(
        'Invalid configuration: TRUST_PROXY',
      )
    }
  })

  it('accepts a complete production environment and carries the Sentry DSN', () => {
    const dsn = 'https://key@o0.ingest.example.test/1'
    const config = loadConfig({ ...production, SENTRY_DSN: dsn })
    expect(config).toMatchObject({ nodeEnv: 'production', trustProxy: 1, sentryDsn: dsn })
  })

  it('defaults TRUST_PROXY to 0 outside production', () => {
    expect(loadConfig(base).trustProxy).toBe(0)
    expect(loadConfig(base).sentryDsn).toBeUndefined()
  })

  it('accepts the development example unchanged outside production', () => {
    const text = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
    const env: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line)
      if (match?.[1]) env[match[1]] = match[2] ?? ''
    }
    expect(env.AUTH_SECRET).toContain('CHANGE_ME')
    expect(() => loadConfig(env)).not.toThrow()
    expect(() => loadConfig({ ...env, NODE_ENV: 'production', TRUST_PROXY: '1' })).toThrow(
      /Invalid configuration: .*DATABASE_URL/,
    )
  })
})

describe('the owner-view pool is not optional', () => {
  it('refuses to start without OWNER_VIEW_DATABASE_URL, because the audit screens need it', () => {
    const rest: Record<string, string> = { ...base }
    delete rest.OWNER_VIEW_DATABASE_URL
    expect(() => loadConfig(rest)).toThrow(/OWNER_VIEW_DATABASE_URL/)
  })
})
