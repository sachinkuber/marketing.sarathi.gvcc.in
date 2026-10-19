import { readFileSync } from 'node:fs'
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

  it('has no static import of the stand-in in main.ts, only a dynamic one inside the choice', () => {
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/^\s*import\b[^\n]*standin/m)
    expect(source).not.toMatch(/from\s+['"][^'"]*standin/)
    expect(source.match(/import\(\s*['"]\.\/standin\.ts['"]\s*\)/g)).toHaveLength(1)
  })
})
