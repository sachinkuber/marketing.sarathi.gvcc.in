import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadAgentDefinition } from '../src/agent-definition.ts'

const SUMMARY = fileURLToPath(new URL('../../../agents/summary', import.meta.url))
const GOOD = {
  agent: 'x_agent',
  version: 1,
  model: 'claude-sonnet-5-5',
  effort: 'low',
  maxTokens: 1024,
  jobClass: 'interactive',
  resultType: 'x.v1',
}

function agentDir(definition: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-def-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'definition.json'), JSON.stringify(definition))
  writeFileSync(join(dir, 'system.md'), 'You are x.')
  writeFileSync(join(dir, 'output.schema.json'), '{"type":"object"}')
  return dir
}

describe('loadAgentDefinition', () => {
  it('parses the summary agent', () => {
    const loaded = loadAgentDefinition(SUMMARY)
    expect(loaded.definition.agent).toBe('summary')
    expect(loaded.definition.resultType).toBe('summary.v1')
    expect(loaded.system.length).toBeGreaterThan(0)
    expect(loaded.outputSchema).toMatchObject({ type: 'object' })
  })

  it('accepts tools and caps', () => {
    const dir = agentDir({
      ...GOOD,
      tools: [{ type: 'web_search_20260209', maxUses: 5 }],
      caps: { searchesPerJob: 10 },
    })
    expect(loadAgentDefinition(dir).definition.tools).toHaveLength(1)
  })

  it('refuses an unknown key, naming it', () => {
    expect(() => loadAgentDefinition(agentDir({ ...GOOD, extra: 1 }))).toThrow(/definition\.json: .*extra/)
  })

  it('refuses maxTokens 0, naming the field', () => {
    expect(() => loadAgentDefinition(agentDir({ ...GOOD, maxTokens: 0 }))).toThrow(
      /definition\.json: maxTokens: /,
    )
  })

  it('refuses a negative cap, naming the field', () => {
    const dir = agentDir({ ...GOOD, caps: { fetchesPerJob: -1 } })
    expect(() => loadAgentDefinition(dir)).toThrow(/definition\.json: caps\.fetchesPerJob: /)
  })

  it('refuses an old tool type, naming the field', () => {
    const dir = agentDir({ ...GOOD, tools: [{ type: 'web_search_20250305', maxUses: 1 }] })
    expect(() => loadAgentDefinition(dir)).toThrow(/definition\.json: tools\.0\.type: /)
  })

  // R42: web_fetch may bound the text of one fetched page, so a large page cannot fill a checkpoint.
  const fetchWith = (maxContentTokens: unknown) =>
    agentDir({ ...GOOD, tools: [{ type: 'web_fetch_20260209', maxUses: 3, maxContentTokens }] })

  it.each([1000, 40000, 100000])('accepts maxContentTokens %i on web_fetch', (n) => {
    expect(loadAgentDefinition(fetchWith(n)).definition.tools).toEqual([
      { type: 'web_fetch_20260209', maxUses: 3, maxContentTokens: n },
    ])
  })

  it.each([999, 100001, 1500.5, '40000', 0])('refuses maxContentTokens %s, naming the field', (n) => {
    expect(() => loadAgentDefinition(fetchWith(n))).toThrow(/definition\.json: tools\.0\.maxContentTokens: /)
  })

  it('refuses maxContentTokens on web_search, naming the field', () => {
    const dir = agentDir({
      ...GOOD,
      tools: [{ type: 'web_search_20260209', maxUses: 3, maxContentTokens: 40000 }],
    })
    expect(() => loadAgentDefinition(dir)).toThrow(
      /definition\.json: tools\.0\.maxContentTokens: only web_fetch_20260209 takes it/,
    )
  })

  it('web_fetch without maxContentTokens is still accepted', () => {
    const dir = agentDir({ ...GOOD, tools: [{ type: 'web_fetch_20260209', maxUses: 3 }] })
    expect(loadAgentDefinition(dir).definition.tools).toEqual([{ type: 'web_fetch_20260209', maxUses: 3 }])
  })
})
