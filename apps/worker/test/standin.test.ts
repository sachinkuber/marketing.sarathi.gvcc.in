import { summaryResultSchema, wrapBrief } from '@mkt/shared'
import { describe, expect, it } from 'vitest'
import { loadWorkerConfig } from '../src/config.ts'
import { chooseModel } from '../src/main.ts'

// The load test (spec 17, test 41) runs the worker with the stand-in model and a fixed answer time,
// STANDIN_DELAY_MS, read only when MODEL_BACKEND=standin (which the configuration accepts only under
// NODE_ENV=test).
const base = {
  CORE_URL: 'http://core.test',
  WORKER_SECRET: 'w'.repeat(32),
  QUEUE_DATABASE_URL: 'postgres://u:p@localhost:5432/q',
}
const standin = { ...base, NODE_ENV: 'test', MODEL_BACKEND: 'standin' }
const request = {
  model: 'claude-sonnet-5-5',
  system: 's',
  maxTokens: 1024,
  messages: [{ role: 'user' as const, content: wrapBrief('A brief.') }],
}

async function timedSend(env: Record<string, string>): Promise<{ ms: number; text: string }> {
  const model = await chooseModel(loadWorkerConfig(env))
  const started = performance.now()
  const reply = await model.send(request)
  return { ms: performance.now() - started, text: reply.text }
}

describe('the stand-in answer time', () => {
  it('the stand-in waits STANDIN_DELAY_MS before answering', async () => {
    const { ms, text } = await timedSend({ ...standin, STANDIN_DELAY_MS: '400' })
    expect(ms).toBeGreaterThanOrEqual(390)
    // Still a summary the contract accepts, so the runs finish.
    expect(summaryResultSchema.safeParse(JSON.parse(text)).success).toBe(true)
  })

  it('answers at once when STANDIN_DELAY_MS is unset or 0', async () => {
    expect(loadWorkerConfig(standin).standinDelayMs).toBe(0)
    expect((await timedSend(standin)).ms).toBeLessThan(200)
    expect((await timedSend({ ...standin, STANDIN_DELAY_MS: '0' })).ms).toBeLessThan(200)
  })

  it('accepts whole milliseconds from 0 to 60000 and refuses anything else, naming only the variable', () => {
    expect(loadWorkerConfig({ ...standin, STANDIN_DELAY_MS: '60000' }).standinDelayMs).toBe(60000)
    expect(loadWorkerConfig({ ...standin, STANDIN_DELAY_MS: '2000' }).standinDelayMs).toBe(2000)
    for (const value of ['-1', '60001', '1.5', 'abc', '', ' 20', '2e3', '0x10']) {
      let message = ''
      try {
        loadWorkerConfig({ ...standin, STANDIN_DELAY_MS: value })
      } catch (e) {
        message = (e as Error).message
      }
      expect(message, value).toBe('Invalid configuration: STANDIN_DELAY_MS')
    }
  })

  it('is not read at all with the real model', () => {
    const config = loadWorkerConfig({ ...base, ANTHROPIC_API_KEY: 'k', STANDIN_DELAY_MS: 'not a number' })
    expect(config.modelBackend).toBe('anthropic')
    expect(config.standinDelayMs).toBe(0)
  })
})
