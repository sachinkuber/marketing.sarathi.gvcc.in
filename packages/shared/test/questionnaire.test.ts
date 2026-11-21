import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  askSchema,
  loadAgentDefinition,
  PROFILE_KEYS,
  QUESTION_KEYS,
  questionnaireInputSchema,
  questionnaireResultSchema,
  SAFETY_KEYS,
} from '../src/index.ts'

const QUESTIONNAIRE = fileURLToPath(new URL('../../../agents/questionnaire', import.meta.url))
const STRATEGY_KEYS = [
  'goals',
  'priority_audiences',
  'proof_points',
  'never_say',
  'competitors_not_named',
  'tone_limits',
  'pause_dates',
  'capacity',
  'success_measures',
]

const question = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  text: 'Which places do you serve?',
  why: 'The site names Pune once, so we want to be sure.',
  options: ['Pune only', 'Pune and Mumbai'],
  suggestedAnswer: 'Pune only',
  ...over,
})
// The safety keys first (a result that does not ask must hold them), then the rest of the keys in order.
const ORDER = [
  ...SAFETY_KEYS,
  ...QUESTION_KEYS.filter((key) => !(SAFETY_KEYS as readonly string[]).includes(key)),
]
// One question on each of the first n keys, so no key repeats; from 4 on, every safety key is there.
const questions = (n: number) => ORDER.slice(0, n).map((key) => question(key))
const result = (over: Record<string, unknown> = {}) => ({ questions: questions(10), ask: null, ...over })
const ask = (over: Record<string, unknown> = {}) => ({
  text: 'What does the business sell, and where?',
  why: 'Research could not read anything about the business.',
  options: [],
  suggested: null,
  ...over,
})
const input = {
  brandName: 'Lumen Shield Coatings',
  profile: [{ key: 'business_name', value: 'Lumen Shield Coatings', status: 'found' }],
  open: [
    { key: 'audiences', proposed: 'Car owners in Pune', confidence: 'assumed', rejected: false },
    { key: 'price_position', proposed: 'Premium', confidence: 'assumed', rejected: true },
  ],
  gaps: [{ key: 'certifications', why: 'Nothing found.' }],
  unreadable: [
    { kind: 'social', address: 'https://www.instagram.com/lumenshield/' },
    { kind: 'document', address: null },
  ],
  competitors: [
    { name: 'Gloss Co', website: 'https://gloss.example/' },
    { name: 'Shine Ltd', website: null },
  ],
}

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success
const issuesOf = (value: unknown) => questionnaireResultSchema.safeParse(value).error?.issues ?? []

describe('the question keys', () => {
  it('are the profile keys, then the nine strategy inputs; four of them feed the safety rules', () => {
    expect(QUESTION_KEYS).toEqual([...PROFILE_KEYS, ...STRATEGY_KEYS])
    expect(SAFETY_KEYS).toEqual(['never_say', 'competitors_not_named', 'tone_limits', 'pause_dates'])
  })
})

describe('questionnaire schemas', () => {
  it('the schemas accept a good example', () => {
    expect(ok(questionnaireInputSchema, input)).toBe(true)
    expect(ok(questionnaireResultSchema, result())).toBe(true)
    // Every key once; a free-text question with or without a suggestion; options with no suggestion.
    expect(ok(questionnaireResultSchema, result({ questions: questions(QUESTION_KEYS.length) }))).toBe(true)
    const mixed = questions(10)
    mixed[0] = question(mixed[0]!.key, { options: [], suggestedAnswer: 'Lumen Shield Coatings' })
    mixed[1] = question(mixed[1]!.key, { options: [], suggestedAnswer: null })
    mixed[2] = question(mixed[2]!.key, { suggestedAnswer: null })
    expect(ok(questionnaireResultSchema, result({ questions: mixed }))).toBe(true)
  })

  it('refuses decision, an unknown key, a repeated profile key and a suggested answer outside its options', () => {
    // decision: only the owner answers, so a result carrying one anywhere is refused.
    expect(ok(questionnaireResultSchema, result({ decision: 'accepted' }))).toBe(false)
    const decided = questions(10)
    decided[0] = question(decided[0]!.key, { decision: 'accepted' })
    expect(ok(questionnaireResultSchema, result({ questions: decided }))).toBe(false)

    const unknown = questions(10)
    unknown[9] = question('favourite_colour')
    expect(ok(questionnaireResultSchema, result({ questions: unknown }))).toBe(false)

    // A second question on a profile key would make the owner answer it twice, and the second answer would
    // replace the first in the profile (ruling R8).
    const repeated = questions(11)
    repeated[10] = question(repeated[4]!.key)
    expect(PROFILE_KEYS).toContain(repeated[4]!.key)
    expect(ok(questionnaireResultSchema, result({ questions: repeated }))).toBe(false)
    expect(issuesOf(result({ questions: repeated }))).toEqual([
      expect.objectContaining({
        path: ['questions', 10, 'key'],
        message: 'this profile key is already asked',
      }),
    ])

    const outside = questions(10)
    outside[0] = question(outside[0]!.key, { suggestedAnswer: 'Mumbai only' })
    expect(ok(questionnaireResultSchema, result({ questions: outside }))).toBe(false)
  })

  it('holds 10 to 30 questions: 30 are possible, 9 and 31 are refused for their count', () => {
    expect(ok(questionnaireResultSchema, result({ questions: questions(9) }))).toBe(false)
    expect(issuesOf(result({ questions: questions(9) }))).toEqual([
      expect.objectContaining({ path: ['questions'], message: 'at least 10 questions, or ask the owner' }),
    ])
    // Every profile key once, every strategy key once, and a second question on some strategy keys (R8).
    const thirty = [...QUESTION_KEYS, ...STRATEGY_KEYS.slice(0, 7)].map((key) => question(key))
    expect(thirty).toHaveLength(30)
    expect(ok(questionnaireResultSchema, result({ questions: thirty }))).toBe(true)
    // 31 with no key past its limit: only the count refuses it.
    const many = [...thirty, question(STRATEGY_KEYS[7]!)]
    expect(issuesOf(result({ questions: many }))).toEqual([
      expect.objectContaining({ code: 'too_big', path: ['questions'] }),
    ])
  })

  it('a strategy key may be asked up to three times, a profile key once (ruling R8)', () => {
    // Ten questions without the key under test, then n questions on it.
    const base = (key: string) => [...questions(11).filter((q) => q.key !== key)].slice(0, 10)
    const times = (key: string, n: number) => [
      ...base(key),
      ...Array.from({ length: n }, () => question(key)),
    ]
    for (const key of STRATEGY_KEYS) {
      expect(ok(questionnaireResultSchema, result({ questions: times(key, 3) })), key).toBe(true)
      expect(issuesOf(result({ questions: times(key, 4) })), key).toEqual([
        expect.objectContaining({
          path: ['questions', 13, 'key'],
          message: 'this strategy key is already asked three times',
        }),
      ])
    }
    for (const key of PROFILE_KEYS.slice(10))
      expect(ok(questionnaireResultSchema, result({ questions: times(key, 2) })), key).toBe(false)
  })

  it('a result that does not ask holds every safety key (they become the safety rules)', () => {
    for (const key of SAFETY_KEYS) {
      const without = [...questions(11).filter((q) => q.key !== key)]
      expect(without).toHaveLength(10)
      expect(issuesOf(result({ questions: without })), key).toEqual([
        expect.objectContaining({ path: ['questions'], message: `${key} is always asked` }),
      ])
    }
    // A result that asks holds no questions, so no safety key either.
    expect(ok(questionnaireResultSchema, { questions: [], ask: ask() })).toBe(true)
  })

  it('options are none or two to six, and the texts hold their limits', () => {
    const withFirst = (over: Record<string, unknown>) => {
      const list = questions(10)
      list[0] = question(list[0]!.key, over)
      return result({ questions: list })
    }
    const six = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(ok(questionnaireResultSchema, withFirst({ options: six, suggestedAnswer: 'f' }))).toBe(true)
    expect(ok(questionnaireResultSchema, withFirst({ options: [...six, 'g'], suggestedAnswer: 'a' }))).toBe(
      false,
    )
    expect(ok(questionnaireResultSchema, withFirst({ options: ['a'], suggestedAnswer: 'a' }))).toBe(false)
    expect(ok(questionnaireResultSchema, withFirst({ text: 'x'.repeat(300) }))).toBe(true)
    expect(ok(questionnaireResultSchema, withFirst({ text: 'x'.repeat(301) }))).toBe(false)
    expect(ok(questionnaireResultSchema, withFirst({ why: 'x'.repeat(300) }))).toBe(true)
    expect(ok(questionnaireResultSchema, withFirst({ why: 'x'.repeat(301) }))).toBe(false)
    const long = 'x'.repeat(200)
    expect(ok(questionnaireResultSchema, withFirst({ options: [long, 'b'], suggestedAnswer: long }))).toBe(
      true,
    )
    expect(
      ok(questionnaireResultSchema, withFirst({ options: [`${long}x`, 'b'], suggestedAnswer: 'b' })),
    ).toBe(false)
    expect(ok(questionnaireResultSchema, withFirst({ options: [], suggestedAnswer: 'x'.repeat(500) }))).toBe(
      true,
    )
    expect(ok(questionnaireResultSchema, withFirst({ options: [], suggestedAnswer: 'x'.repeat(501) }))).toBe(
      false,
    )
  })

  it('refuses invisible characters and blank text in what the owner will read', () => {
    const zeroWidth = `a${String.fromCodePoint(0x200b)}b`
    const list = (over: Record<string, unknown>) => {
      const all = questions(10)
      all[0] = question(all[0]!.key, over)
      return result({ questions: all })
    }
    expect(ok(questionnaireResultSchema, list({ text: zeroWidth }))).toBe(false)
    expect(ok(questionnaireResultSchema, list({ why: '  ' }))).toBe(false)
    expect(ok(questionnaireResultSchema, list({ options: [zeroWidth, 'b'], suggestedAnswer: 'b' }))).toBe(
      false,
    )
    expect(ok(questionnaireResultSchema, { questions: [], ask: ask({ text: zeroWidth }) })).toBe(false)
  })

  it('an open suggestion says whether the owner rejected it (ruling R9)', () => {
    const open = (over: Record<string, unknown>) => ({ ...input, open: [{ ...input.open[0], ...over }] })
    expect(ok(questionnaireInputSchema, open({ rejected: true }))).toBe(true)
    expect(ok(questionnaireInputSchema, open({ rejected: undefined }))).toBe(false)
    expect(ok(questionnaireInputSchema, open({ rejected: 'yes' }))).toBe(false)
  })

  it('the input refuses an unknown key, an unknown status, an unknown source kind and an extra field', () => {
    expect(ok(questionnaireInputSchema, { ...input, extra: 1 })).toBe(false)
    const profile = (over: Record<string, unknown>) => ({
      ...input,
      profile: [{ ...input.profile[0], ...over }],
    })
    expect(ok(questionnaireInputSchema, profile({ key: 'goals' }))).toBe(false)
    expect(ok(questionnaireInputSchema, profile({ status: 'verified' }))).toBe(false)
    expect(ok(questionnaireInputSchema, profile({ decision: 'accepted' }))).toBe(false)
    expect(
      ok(questionnaireInputSchema, { ...input, unreadable: [{ kind: 'owner_statement', address: null }] }),
    ).toBe(false)
    expect(ok(questionnaireInputSchema, { ...input, gaps: [{ key: 'favourite_colour', why: 'x' }] })).toBe(
      false,
    )
  })
})

describe('asking instead of guessing (ruling R7)', () => {
  it('a result that asks carries no questions, and one that does not ask carries at least ten', () => {
    expect(ok(questionnaireResultSchema, { questions: [], ask: ask() })).toBe(true)
    expect(
      ok(questionnaireResultSchema, {
        questions: [],
        ask: ask({ options: ['Car coatings', 'Bike coatings'], suggested: 'Car coatings' }),
      }),
    ).toBe(true)
    expect(ok(questionnaireResultSchema, { questions: questions(10), ask: ask() })).toBe(false)
    expect(ok(questionnaireResultSchema, { questions: [], ask: null })).toBe(false)
    // ask is always present: null when the agent does not ask.
    expect(ok(questionnaireResultSchema, { questions: questions(10) })).toBe(false)
  })

  it('the question asked holds the limits the core takes', () => {
    expect(ok(askSchema, ask())).toBe(true)
    expect(ok(askSchema, ask({ extra: 1 }))).toBe(false)
    expect(ok(askSchema, ask({ text: 'x'.repeat(500) }))).toBe(true)
    expect(ok(askSchema, ask({ text: 'x'.repeat(501) }))).toBe(false)
    expect(ok(askSchema, ask({ why: 'x'.repeat(301) }))).toBe(false)
    expect(ok(askSchema, ask({ options: ['a', 'b', 'c', 'd', 'e'] }))).toBe(true)
    expect(ok(askSchema, ask({ options: ['a', 'b', 'c', 'd', 'e', 'f'] }))).toBe(false)
    expect(ok(askSchema, ask({ options: ['x'.repeat(201)] }))).toBe(false)
    expect(ok(askSchema, ask({ suggested: 'x'.repeat(500) }))).toBe(true)
    expect(ok(askSchema, ask({ suggested: 'x'.repeat(501) }))).toBe(false)
  })

  it('with options, the suggestion is one of them or null', () => {
    expect(
      ok(askSchema, ask({ options: ['Car coatings', 'Bike coatings'], suggested: 'Car coatings' })),
    ).toBe(true)
    expect(ok(askSchema, ask({ options: ['Car coatings', 'Bike coatings'], suggested: null }))).toBe(true)
    expect(ok(askSchema, ask({ options: [], suggested: 'Car coatings' }))).toBe(true)
    expect(
      askSchema.safeParse(ask({ options: ['Car coatings', 'Bike coatings'], suggested: 'Boats' })).error
        ?.issues,
    ).toEqual([
      expect.objectContaining({ path: ['suggested'], message: 'the suggestion is not one of the options' }),
    ])
  })
})

describe('the questionnaire agent', () => {
  it('the folder loads with loadAgentDefinition', () => {
    const loaded = loadAgentDefinition(QUESTIONNAIRE)
    expect(loaded.definition).toEqual({
      agent: 'questionnaire',
      version: 1,
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      maxTokens: 16000,
      jobClass: 'production',
      resultType: 'questionnaire.v1',
    })
    expect(loaded.system.length).toBeGreaterThan(0)
  })

  it('output.schema.json equals the generated JSON schema, with no anyOf at its root', () => {
    const file = JSON.parse(readFileSync(`${QUESTIONNAIRE}/output.schema.json`, 'utf8'))
    expect(file).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(questionnaireResultSchema))))
    // Ruling R7: one object at the root; only `ask` may be null.
    expect(file).not.toHaveProperty('anyOf')
    expect(file.type).toBe('object')
    expect(file.required).toEqual(['questions', 'ask'])
    expect(file.properties.ask.anyOf).toContainEqual({ type: 'null' })
  })

  it('the prompt names every question key', () => {
    const { system } = loadAgentDefinition(QUESTIONNAIRE)
    for (const key of QUESTION_KEYS) expect(system, key).toContain(key)
  })
})
