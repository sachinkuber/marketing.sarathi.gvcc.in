import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

const base = {
  DATABASE_URL: 'postgres://app:pw@127.0.0.1:5432/mkt',
  AUTH_SECRET: 'a'.repeat(32),
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
    })
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
    expect(message).toContain('AUTH_SECRET')
    expect(message).toContain('PUBLIC_ORIGIN')
    expect(message).not.toContain(secret)
  })
})
