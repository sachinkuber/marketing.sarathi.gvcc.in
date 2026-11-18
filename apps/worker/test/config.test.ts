import { readFileSync } from 'node:fs'
import { summaryResultSchema, wrapBrief } from '@mkt/shared'
import { describe, expect, it } from 'vitest'
import { loadWorkerConfig } from '../src/config.ts'
import { chooseModel } from '../src/main.ts'

const SECRET_KEY = 'sk-ant-very-secret-key-value'
const base = {
  CORE_URL: 'http://core.test',
  WORKER_SECRET: 'w'.repeat(32),
  QUEUE_DATABASE_URL: 'postgres://u:p@localhost:5432/q',
}

describe('the model backend choice', () => {
  it('is the real Anthropic path by default', async () => {
    const config = loadWorkerConfig({ ...base, ANTHROPIC_API_KEY: SECRET_KEY })
    expect(config.modelBackend).toBe('anthropic')
    expect(config.anthropicApiKey).toBe(SECRET_KEY)
    expect(typeof (await chooseModel(config)).send).toBe('function')
  })

  it('names the missing key and nothing else', () => {
    const error = (() => {
      try {
        loadWorkerConfig({ ...base })
      } catch (e) {
        return e as Error
      }
    })()
    expect(error?.message).toBe('Invalid configuration: ANTHROPIC_API_KEY')
  })

  it('does not put a bad value, or the key, in the error', () => {
    const error = (() => {
      try {
        loadWorkerConfig({ ...base, ANTHROPIC_API_KEY: SECRET_KEY, WORKER_SECRET: 'short' })
      } catch (e) {
        return e as Error
      }
    })()
    expect(error?.message).toBe('Invalid configuration: WORKER_SECRET')
    expect(error?.message).not.toContain(SECRET_KEY)
  })

  it('refuses the stand-in outside test mode', () => {
    for (const NODE_ENV of ['production', 'development', undefined]) {
      expect(() =>
        loadWorkerConfig({ ...base, ...(NODE_ENV ? { NODE_ENV } : {}), MODEL_BACKEND: 'standin' }),
      ).toThrow('Invalid configuration: MODEL_BACKEND')
    }
  })

  it('takes the stand-in under NODE_ENV=test without a key', async () => {
    const config = loadWorkerConfig({ ...base, NODE_ENV: 'test', MODEL_BACKEND: 'standin' })
    expect(config.modelBackend).toBe('standin')
    expect(typeof (await chooseModel(config)).send).toBe('function')
  })

  it('the stand-in chosen at start answers a summary the contract accepts (the compose stack test runs it)', async () => {
    const config = loadWorkerConfig({ ...base, NODE_ENV: 'test', MODEL_BACKEND: 'standin' })
    const reply = await (
      await chooseModel(config)
    ).send({
      model: 'claude-opus-5-5',
      system: 's',
      maxTokens: 1024,
      messages: [{ role: 'user', content: wrapBrief('A brief.') }],
    })
    expect(reply.stopReason).toBe('end_turn')
    expect(summaryResultSchema.safeParse(JSON.parse(reply.text)).success).toBe(true)
  })

  it('has no static import of the stand-in in main.ts, only a dynamic one inside the choice', () => {
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/^\s*import\b[^\n]*standin/m)
    expect(source).not.toMatch(/from\s+['"][^'"]*standin/)
    expect(source.match(/import\(\s*['"]\.\/standin\.ts['"]\s*\)/g)).toHaveLength(1)
  })
})

describe('production refusals', () => {
  const production = {
    ...base,
    NODE_ENV: 'production',
    ANTHROPIC_API_KEY: SECRET_KEY,
    CORE_URL: 'https://core.test',
  }

  it('refuses CHANGE_ME in any value in production, naming the variable and not the value', () => {
    for (const key of ['ANTHROPIC_API_KEY', 'WORKER_SECRET', 'QUEUE_DATABASE_URL']) {
      const env: Record<string, string> = { ...production }
      env[key] =
        key === 'QUEUE_DATABASE_URL'
          ? 'postgres://u:CHANGE_ME@localhost:5432/q'
          : `${'k'.repeat(40)}CHANGE_ME`
      let message = ''
      try {
        loadWorkerConfig(env)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toContain(key)
      expect(message).not.toContain('CHANGE_ME')
    }
  })

  it('accepts CHANGE_ME outside production', () => {
    expect(() => loadWorkerConfig({ ...base, ANTHROPIC_API_KEY: 'CHANGE_ME' })).not.toThrow()
  })

  it('carries the Sentry DSN, and refuses CHANGE_ME in it in production', () => {
    const dsn = 'https://key@o0.ingest.example.test/1'
    expect(loadWorkerConfig({ ...production, SENTRY_DSN: dsn }).sentryDsn).toBe(dsn)
    expect(loadWorkerConfig({ ...production }).sentryDsn).toBeUndefined()
    expect(() =>
      loadWorkerConfig({ ...production, SENTRY_DSN: 'https://CHANGE_ME@o0.example.test/1' }),
    ).toThrow('SENTRY_DSN')
  })
})

describe('the maintenance interval', () => {
  // The core reports the worker stale after 900 s without a beat; 450 s leaves room for one missed tick.
  it('accepts up to 450 seconds', () => {
    const config = loadWorkerConfig({ ...base, ANTHROPIC_API_KEY: SECRET_KEY, RECONCILE_INTERVAL_SECONDS: '450' })
    expect(config.reconcileIntervalSeconds).toBe(450)
  })

  it('refuses more than 450 seconds, naming the variable', () => {
    expect(() =>
      loadWorkerConfig({ ...base, ANTHROPIC_API_KEY: SECRET_KEY, RECONCILE_INTERVAL_SECONDS: '451' }),
    ).toThrow('Invalid configuration: RECONCILE_INTERVAL_SECONDS')
  })
})
