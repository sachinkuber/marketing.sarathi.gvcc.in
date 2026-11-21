import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  factsRulesAgainstInput,
  factsRulesInputSchema,
  factsRulesResultSchema,
  loadAgentDefinition,
  MAX_FACTS,
  MAX_RULES,
  RESEARCH_SOURCE_KINDS,
  SAFETY_RULE_KINDS,
  SOURCE_KINDS,
} from '../src/index.ts'

const FACTS_RULES = fileURLToPath(new URL('../../../agents/facts_rules', import.meta.url))
const SITE = '517e0000-0000-4000-8000-000000000001'
const BROCHURE = 'd0c00000-0000-4000-8000-000000000001'
const NEVER_SAY = 'a5a50000-0000-4000-8000-000000000001'
const RIVAL = 'c0c00000-0000-4000-8000-000000000001'
const ELSEWHERE = 'eeee0000-0000-4000-8000-000000000001'

const fact = (over: Record<string, unknown> = {}) => ({
  statement: 'Lumen Shield Coatings has worked from Baner, Pune since 2015.',
  why: 'The about page says so.',
  sourceIds: [SITE],
  reviewDate: '2027-11-21',
  ...over,
})
const rule = (over: Record<string, unknown> = {}) => ({
  kind: 'forbidden_claim',
  text: 'Never call the coatings permanent.',
  why: 'Your answer on what never to say.',
  sourceIds: [NEVER_SAY],
  ...over,
})
const ask = (over: Record<string, unknown> = {}) => ({
  text: 'Your answers give two warranty lengths. Which is right?',
  why: 'A warranty fact must say one length.',
  options: ['5 years', '3 years'],
  suggested: null,
  ...over,
})
const result = (over: Record<string, unknown> = {}) => ({
  facts: [fact()],
  rules: [rule()],
  ask: null,
  ...over,
})
const source = (id: string, kind: string, over: Record<string, unknown> = {}) => ({
  id,
  kind,
  address: kind === 'document' || kind === 'owner_statement' ? null : 'https://lumenshield.example/about',
  documentName: kind === 'document' ? 'Lumen Shield brochure 2026.pdf' : null,
  extract: 'Coating cars in Baner, Pune since 2015.',
  ...over,
})
const input = {
  today: '2026-11-21',
  brandName: 'Lumen Shield Coatings',
  sources: [
    source(SITE, 'site'),
    source(BROCHURE, 'document'),
    source(NEVER_SAY, 'owner_statement', { extract: 'Never call the coatings permanent.' }),
    source(RIVAL, 'competitor', { address: 'https://gloss.example/compare' }),
  ],
  profile: [{ key: 'places_served', value: 'Baner, Pune', status: 'found', sourceIds: [SITE] }],
  answers: [
    {
      key: 'never_say',
      question: 'What must the brand never say?',
      answer: 'Never call the coatings permanent.',
      sourceId: NEVER_SAY,
    },
  ],
}

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success
const issuesOf = (value: unknown) => factsRulesResultSchema.safeParse(value).error?.issues ?? []

describe('the kinds', () => {
  it('rule kinds are exactly M8’s; source kinds are research’s and the owner’s own word (app.source_kind)', () => {
    expect(SAFETY_RULE_KINDS).toEqual([
      'forbidden_topic',
      'forbidden_claim',
      'forbidden_word',
      'competitor_not_named',
      'tone_limit',
      'pause_dates',
    ])
    expect(SOURCE_KINDS).toEqual([...RESEARCH_SOURCE_KINDS, 'owner_statement'])
    expect(SOURCE_KINDS).toEqual(['site', 'social', 'search', 'document', 'competitor', 'owner_statement'])
  })
})

describe('facts and rules schemas', () => {
  it('the schema accepts a good example', () => {
    expect(ok(factsRulesInputSchema, input)).toBe(true)
    expect(ok(factsRulesResultSchema, result())).toBe(true)
    // Every rule kind; a fact citing several sources; nothing to propose at all.
    expect(
      ok(factsRulesResultSchema, result({ rules: SAFETY_RULE_KINDS.map((kind) => rule({ kind })) })),
    ).toBe(true)
    expect(ok(factsRulesResultSchema, result({ facts: [fact({ sourceIds: [SITE, BROCHURE] })] }))).toBe(true)
    expect(ok(factsRulesResultSchema, { facts: [], rules: [], ask: null })).toBe(true)
  })

  it('refuses decision, an empty sourceIds, an unknown rule kind, a malformed review date and 41 facts', () => {
    // Only the owner decides (test 43): a result carrying a decision anywhere is refused.
    expect(ok(factsRulesResultSchema, result({ decision: 'accepted' }))).toBe(false)
    expect(ok(factsRulesResultSchema, result({ facts: [fact({ decision: 'accepted' })] }))).toBe(false)
    expect(ok(factsRulesResultSchema, result({ rules: [rule({ decision: 'accepted' })] }))).toBe(false)
    // Every fact and every rule cites at least one source (test 44).
    expect(ok(factsRulesResultSchema, result({ facts: [fact({ sourceIds: [] })] }))).toBe(false)
    expect(ok(factsRulesResultSchema, result({ rules: [rule({ sourceIds: [] })] }))).toBe(false)
    expect(ok(factsRulesResultSchema, result({ facts: [fact({ sourceIds: ['s1'] })] }))).toBe(false)
    expect(ok(factsRulesResultSchema, result({ rules: [rule({ kind: 'forbidden_emoji' })] }))).toBe(false)
    for (const reviewDate of ['2027-02-30', '2027-2-21', '21-11-2027', '2027-11-21T00:00:00Z', ''])
      expect(ok(factsRulesResultSchema, result({ facts: [fact({ reviewDate })] })), reviewDate).toBe(false)
    expect(ok(factsRulesResultSchema, result({ facts: [fact({ reviewDate: '2028-02-29' })] }))).toBe(true)
    const many = (n: number) => Array.from({ length: n }, (_, i) => fact({ statement: `Fact ${i}.` }))
    expect(ok(factsRulesResultSchema, result({ facts: many(MAX_FACTS) }))).toBe(true)
    expect(issuesOf(result({ facts: many(MAX_FACTS + 1) }))).toEqual([
      expect.objectContaining({ code: 'too_big', path: ['facts'] }),
    ])
    expect(MAX_FACTS).toBe(40)
    const rules = (n: number) => Array.from({ length: n }, (_, i) => rule({ text: `Rule ${i}.` }))
    expect(ok(factsRulesResultSchema, result({ rules: rules(MAX_RULES) }))).toBe(true)
    expect(ok(factsRulesResultSchema, result({ rules: rules(MAX_RULES + 1) }))).toBe(false)
    expect(MAX_RULES).toBe(30)
  })

  it('statements, rule texts and whys hold 300 characters and are visible text', () => {
    const long = 'x'.repeat(300)
    expect(ok(factsRulesResultSchema, result({ facts: [fact({ statement: long, why: long })] }))).toBe(true)
    expect(ok(factsRulesResultSchema, result({ facts: [fact({ statement: `${long}x` })] }))).toBe(false)
    expect(ok(factsRulesResultSchema, result({ facts: [fact({ why: `${long}x` })] }))).toBe(false)
    expect(ok(factsRulesResultSchema, result({ rules: [rule({ text: long, why: long })] }))).toBe(true)
    expect(ok(factsRulesResultSchema, result({ rules: [rule({ text: `${long}x` })] }))).toBe(false)
    expect(ok(factsRulesResultSchema, result({ rules: [rule({ why: `${long}x` })] }))).toBe(false)
    const zeroWidth = `a${String.fromCodePoint(0x200b)}b`
    expect(ok(factsRulesResultSchema, result({ facts: [fact({ statement: zeroWidth })] }))).toBe(false)
    expect(ok(factsRulesResultSchema, result({ rules: [rule({ text: '  ' })] }))).toBe(false)
  })

  it('the input refuses an unknown key, kind or status, an extra field, and a malformed today', () => {
    expect(ok(factsRulesInputSchema, { ...input, extra: 1 })).toBe(false)
    expect(ok(factsRulesInputSchema, { ...input, today: '2026-11-31' })).toBe(false)
    const profile = (over: Record<string, unknown>) => ({
      ...input,
      profile: [{ ...input.profile[0], ...over }],
    })
    expect(ok(factsRulesInputSchema, profile({ key: 'never_say' }))).toBe(false)
    expect(ok(factsRulesInputSchema, profile({ status: 'verified' }))).toBe(false)
    // An unknown item may cite nothing.
    expect(ok(factsRulesInputSchema, profile({ status: 'unknown', sourceIds: [] }))).toBe(true)
    const answer = (over: Record<string, unknown>) => ({
      ...input,
      answers: [{ ...input.answers[0], ...over }],
    })
    expect(ok(factsRulesInputSchema, answer({ key: 'favourite_colour' }))).toBe(false)
    expect(ok(factsRulesInputSchema, answer({ answer: '' }))).toBe(false)
    const withSource = (over: Record<string, unknown>) => ({
      ...input,
      sources: [...input.sources.slice(1), { ...input.sources[0], ...over }],
    })
    expect(ok(factsRulesInputSchema, withSource({ kind: 'review' }))).toBe(false)
    expect(ok(factsRulesInputSchema, withSource({ extract: '' }))).toBe(false)
  })

  it('the input lists every source its profile items and answers cite, once each', () => {
    expect(
      factsRulesInputSchema.safeParse({
        ...input,
        profile: [{ ...input.profile[0], sourceIds: [ELSEWHERE] }],
      }).error?.issues,
    ).toEqual([
      expect.objectContaining({
        path: ['profile', 0, 'sourceIds', 0],
        message: 'not one of the listed sources',
      }),
    ])
    expect(
      factsRulesInputSchema.safeParse({ ...input, answers: [{ ...input.answers[0], sourceId: ELSEWHERE }] })
        .error?.issues,
    ).toEqual([
      expect.objectContaining({ path: ['answers', 0, 'sourceId'], message: 'not one of the listed sources' }),
    ])
    expect(
      factsRulesInputSchema.safeParse({ ...input, sources: [...input.sources, source(SITE, 'site')] }).error
        ?.issues,
    ).toEqual([expect.objectContaining({ path: ['sources', 4, 'id'], message: 'two sources share this id' })])
  })
})

describe('asking instead of guessing (ruling R7)', () => {
  it('a result that asks holds no facts and no rules', () => {
    expect(ok(factsRulesResultSchema, { facts: [], rules: [], ask: ask() })).toBe(true)
    expect(issuesOf({ facts: [fact()], rules: [], ask: ask() })).toEqual([
      expect.objectContaining({ path: ['facts'], message: 'a result that asks holds no facts or rules' }),
    ])
    expect(issuesOf({ facts: [], rules: [rule()], ask: ask() })).toEqual([
      expect.objectContaining({ path: ['rules'], message: 'a result that asks holds no facts or rules' }),
    ])
    // ask is always present: null when the agent does not ask.
    expect(ok(factsRulesResultSchema, { facts: [fact()], rules: [] })).toBe(false)
    // The question holds askSchema's limits, the suggestion among its options.
    expect(ok(factsRulesResultSchema, { facts: [], rules: [], ask: ask({ suggested: '4 years' }) })).toBe(
      false,
    )
    expect(ok(factsRulesResultSchema, { facts: [], rules: [], ask: ask({ text: 'x'.repeat(501) }) })).toBe(
      false,
    )
  })
})

describe('a result against its input', () => {
  it('every cited id is one of the input sources and every review date is after today', () => {
    expect(factsRulesAgainstInput(factsRulesResultSchema.parse(result()), input, [])).toEqual([])
    const outside = factsRulesResultSchema.parse(
      result({
        facts: [fact({ sourceIds: [SITE, ELSEWHERE] })],
        rules: [rule({ sourceIds: [ELSEWHERE] })],
      }),
    )
    expect(factsRulesAgainstInput(outside, input, [])).toEqual([
      { path: ['facts', 0, 'sourceIds', 1], message: 'not one of the input sources' },
      { path: ['rules', 0, 'sourceIds', 0], message: 'not one of the input sources' },
    ])
    for (const reviewDate of ['2026-11-21', '2026-11-20', '2025-01-01']) {
      const stale = factsRulesResultSchema.parse(result({ facts: [fact({ reviewDate })] }))
      expect(factsRulesAgainstInput(stale, input, []), reviewDate).toEqual([
        { path: ['facts', 0, 'reviewDate'], message: 'the review date is not after today' },
      ])
    }
    const tomorrow = factsRulesResultSchema.parse(result({ facts: [fact({ reviewDate: '2026-11-22' })] }))
    expect(factsRulesAgainstInput(tomorrow, input, [])).toEqual([])
  })

  it('an answer to an agent question is a listed source (ruling R11); an unknown id still is not', () => {
    const ANSWERED = 'a5a50000-0000-4000-8000-000000000008'
    const answers = [{ sourceId: ANSWERED }]
    const citing = factsRulesResultSchema.parse(
      result({
        facts: [fact({ sourceIds: [ANSWERED] })],
        rules: [rule({ sourceIds: [ANSWERED, NEVER_SAY] })],
      }),
    )
    expect(factsRulesAgainstInput(citing, input, answers)).toEqual([])
    // Without the answers it is not listed: the job's answers are part of what the result may cite.
    expect(factsRulesAgainstInput(citing, input, [])).toEqual([
      { path: ['facts', 0, 'sourceIds', 0], message: 'not one of the input sources' },
      { path: ['rules', 0, 'sourceIds', 0], message: 'not one of the input sources' },
    ])
    const unknown = factsRulesResultSchema.parse(
      result({ facts: [fact({ sourceIds: [ANSWERED, ELSEWHERE] })] }),
    )
    expect(factsRulesAgainstInput(unknown, input, answers)).toEqual([
      { path: ['facts', 0, 'sourceIds', 1], message: 'not one of the input sources' },
    ])
  })
})

describe('the facts and rules agent', () => {
  it('the folder loads with loadAgentDefinition', () => {
    const loaded = loadAgentDefinition(FACTS_RULES)
    expect(loaded.definition).toEqual({
      agent: 'facts_rules',
      version: 1,
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      maxTokens: 16000,
      jobClass: 'production',
      resultType: 'facts_rules.v1',
    })
    expect(loaded.system.length).toBeGreaterThan(0)
  })

  it('output.schema.json equals the generated JSON schema, with no anyOf at its root', () => {
    const file = JSON.parse(readFileSync(`${FACTS_RULES}/output.schema.json`, 'utf8'))
    expect(file).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(factsRulesResultSchema))))
    // Ruling R7: one object at the root; only `ask` may be null.
    expect(file).not.toHaveProperty('anyOf')
    expect(file.type).toBe('object')
    expect(file.required).toEqual(['facts', 'rules', 'ask'])
    expect(file.properties.ask.anyOf).toContainEqual({ type: 'null' })
    expect(file.properties.rules.items.properties.kind.enum).toEqual([...SAFETY_RULE_KINDS])
    expect(file.properties.facts.items.properties.reviewDate.format).toBe('date')
  })

  it('the prompt names the answers rules come from and never ignores an owner’s real statement (ruling R13)', () => {
    const { system } = loadAgentDefinition(FACTS_RULES)
    expect(system).toContain(
      'Rules come from the never_say, competitors_not_named, tone_limits and pause_dates answers and from documents; another answer gives a rule only when it states one.',
    )
    expect(system).not.toContain('mainly')
    // Only text claiming to be a note to the agent is ignored: the owner's own answers are what the rules rest on.
    expect(system).toContain('claims to be a note to you from the owner or the system')
    expect(system).not.toContain('claims to come from the owner')
  })

  it('the prompt says an answer to an agent question is an owner statement a fact can cite (ruling R11)', () => {
    const { system } = loadAgentDefinition(FACTS_RULES)
    expect(system).toMatch(/`owner_answer`[^\n]*also listed as an `owner_statement` source/)
    expect(system).not.toMatch(/when no source does, leave the fact out/)
  })

  it('the prompt names every rule kind, the answers rules come from, and the kinds a fact never rests on alone', () => {
    const { system } = loadAgentDefinition(FACTS_RULES)
    for (const word of [
      ...SAFETY_RULE_KINDS,
      'never_say',
      'competitors_not_named',
      'tone_limits',
      'pause_dates',
      'competitor',
      'search',
      'social',
    ])
      expect(system, word).toContain(word)
  })
})
