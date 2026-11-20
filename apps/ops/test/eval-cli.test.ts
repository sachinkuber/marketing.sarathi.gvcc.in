import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../src/eval-cli.ts', import.meta.url))

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: r.status, out: r.stdout + r.stderr }
}

describe('eval cli exit codes', () => {
  it('refuses bad arguments with 2', () => {
    expect(run(['--nope']).code).toBe(2)
  })
  it('refuses an unknown agent with 2', () => {
    expect(run(['--agent', 'nothing'], { ADMIN_DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'k' }).code).toBe(2)
  })
  it('refuses a missing environment with 2', () => {
    expect(run(['--agent', 'summary']).code).toBe(2)
  })
  it('exits 3 when the database is down, printing neither address nor key', () => {
    const r = run(['--agent', 'summary'], {
      ADMIN_DATABASE_URL: 'postgres://u:pw-secret@127.0.0.1:1/db',
      ANTHROPIC_API_KEY: 'key-secret',
    })
    expect(r.code).toBe(3)
    expect(r.out).not.toContain('pw-secret')
    expect(r.out).not.toContain('key-secret')
  })
})
