import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Two live DATABASE_URL lines mean the one that wins depends on order: the superuser one last would run
// the core service as superuser and bypass row-level security.
describe('.env.example', () => {
  const lines = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8').split('\n')

  it('has exactly one live DATABASE_URL line, for the run-time role', () => {
    const live = lines.filter((line) => /^\s*DATABASE_URL=/.test(line))
    expect(live).toHaveLength(1)
    expect(live[0]).toMatch(/^DATABASE_URL=postgres:\/\/mkt_app:/)
  })

  it('has exactly one live AUDIT_DATABASE_URL line, for the audit-writer role', () => {
    const live = lines.filter((line) => /^\s*AUDIT_DATABASE_URL=/.test(line))
    expect(live).toHaveLength(1)
    expect(live[0]).toMatch(/^AUDIT_DATABASE_URL=postgres:\/\/mkt_audit_writer:/)
  })

  it('lists the keys the worker requires, live', () => {
    for (const key of ['CORE_URL', 'WORKER_SECRET', 'QUEUE_DATABASE_URL', 'ANTHROPIC_API_KEY']) {
      expect(lines.some((line) => line.startsWith(`${key}=`))).toBe(true)
    }
  })

  it('lists the trigger secret the core requires, live', () => {
    expect(lines.some((line) => line.startsWith('TRIGGER_SECRET='))).toBe(true)
  })

  it('has exactly one live OWNER_VIEW_DATABASE_URL line, for the owner-view role', () => {
    const live = lines.filter((line) => /^\s*OWNER_VIEW_DATABASE_URL=/.test(line))
    expect(live).toHaveLength(1)
    expect(live[0]).toMatch(/^OWNER_VIEW_DATABASE_URL=postgres:\/\/mkt_owner_view:/)
  })

  it('says the heartbeat is not expected until the workflow is live', () => {
    expect(lines).toContain('N8N_HEARTBEAT_EXPECTED=false')
  })

  it('carries the mail settings as placeholders only, never live', () => {
    for (const key of ['SMTP_URL', 'MAIL_FROM']) {
      expect(lines.some((line) => line.startsWith(`${key}=`))).toBe(false)
      expect(lines.some((line) => line.startsWith(`# ${key}=`))).toBe(true)
    }
    const text = lines.join('\n')
    expect(text).not.toMatch(/smtps?:\/\/[^\s:@]+:(?!CHANGE_ME)[^\s@]+@/)
  })
})
