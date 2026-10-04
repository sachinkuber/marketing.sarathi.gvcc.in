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
})
