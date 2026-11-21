import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BASELINE_NEEDED,
  briefChoicesInputSchema,
  briefChoicesResultSchema,
  CHOICE_KEYS,
  loadAgentDefinition,
} from '../src/index.ts'

const BRIEF_CHOICES = fileURLToPath(new URL('../../../agents/brief_choices', import.meta.url))
const FACT = '00000000-0000-4000-8000-0000000000f1'
const input = {
  brandName: 'Lumen Shield Coatings',
  profile: [{ key: 'business_name', value: 'Lumen Shield Coatings', status: 'found' }],
  facts: [{ id: FACT, statement: 'We coat cars in Pune.' }],
  rules: [{ kind: 'forbidden_word', text: 'cheap' }],
  answers: [{ key: 'goals', question: 'What do you want?', answer: 'More enquiries' }],
}
const choice = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  question: 'Who do we speak to first?',
  why: 'The audiences overlap.',
  options: [
    { value: 'Car owners', tradeOff: 'Largest group, most competition.', recommended: true },
    { value: 'Fleet managers', tradeOff: 'Smaller, steadier.', recommended: false },
  ],
  ...over,
})
const choices = (n: number) => CHOICE_KEYS.slice(0, n).map((key) => choice(key))
const result = (over: Record<string, unknown> = {}) => ({ choices: choices(3), ask: null, ...over })
const ask = {
  text: 'What does the business sell?',
  why: 'Nothing is known.',
  options: [],
  suggested: null,
}

describe('brief choices', () => {
  it('exports the keys and the baseline marker', () => {
    expect(CHOICE_KEYS).toEqual([
      'lead_audience',
      'positioning_angle',
      'first_channels',
      'content_focus',
      'posting_rhythm',
      'goal_focus',
    ])
    expect(BASELINE_NEEDED).toBe('baseline needed (B1)')
  })

  it('accepts an input and refuses one without facts', () => {
    expect(briefChoicesInputSchema.safeParse(input).success).toBe(true)
    expect(briefChoicesInputSchema.safeParse({ ...input, facts: [] }).success).toBe(false)
    expect(briefChoicesInputSchema.safeParse({ ...input, extra: 1 }).success).toBe(false)
  })

  it('choices: 3 to 6, unique keys, exactly one recommended option, 2 or 3 options with distinct values', () => {
    for (const n of [3, 4, 6])
      expect(briefChoicesResultSchema.safeParse(result({ choices: choices(n) })).success).toBe(true)
    expect(briefChoicesResultSchema.safeParse(result({ choices: choices(2) })).success).toBe(false)
    expect(briefChoicesResultSchema.safeParse(result({ choices: [] })).success).toBe(false)
    // duplicate key
    expect(
      briefChoicesResultSchema.safeParse(
        result({ choices: [choice('lead_audience'), choice('lead_audience'), choice('goal_focus')] }),
      ).success,
    ).toBe(false)
    const withOptions = (options: unknown[]) =>
      result({ choices: [choice('lead_audience', { options }), ...choices(3).slice(1)] })
    const opt = (value: string, recommended: boolean) => ({ value, tradeOff: 'x', recommended })
    // none or two recommended
    expect(briefChoicesResultSchema.safeParse(withOptions([opt('A', false), opt('B', false)])).success).toBe(
      false,
    )
    expect(briefChoicesResultSchema.safeParse(withOptions([opt('A', true), opt('B', true)])).success).toBe(
      false,
    )
    // one or four options
    expect(briefChoicesResultSchema.safeParse(withOptions([opt('A', true)])).success).toBe(false)
    expect(
      briefChoicesResultSchema.safeParse(
        withOptions([opt('A', true), opt('B', false), opt('C', false), opt('D', false)]),
      ).success,
    ).toBe(false)
    expect(
      briefChoicesResultSchema.safeParse(withOptions([opt('A', true), opt('B', false), opt('C', false)]))
        .success,
    ).toBe(true)
    // same value, trimmed, any case
    expect(
      briefChoicesResultSchema.safeParse(withOptions([opt('Car owners', true), opt(' car OWNERS ', false)]))
        .success,
    ).toBe(false)
  })

  it('a result that asks holds nothing else', () => {
    expect(briefChoicesResultSchema.safeParse({ choices: [], ask }).success).toBe(true)
    expect(briefChoicesResultSchema.safeParse({ choices: choices(3), ask }).success).toBe(false)
  })

  it('output schema: no anyOf at its root, ask may be null', () => {
    const schema = JSON.parse(JSON.stringify(z.toJSONSchema(briefChoicesResultSchema)))
    expect(schema).not.toHaveProperty('anyOf')
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['choices', 'ask'])
    expect(schema.properties.ask.anyOf).toContainEqual({ type: 'null' })
  })
})

describe('the brief_choices agent', () => {
  it('the folder loads with loadAgentDefinition', () => {
    const loaded = loadAgentDefinition(BRIEF_CHOICES)
    expect(loaded.definition).toEqual({
      agent: 'brief_choices',
      version: 1,
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      maxTokens: 16000,
      jobClass: 'production',
      resultType: 'brief_choices.v1',
    })
    expect(loaded.system.length).toBeGreaterThan(0)
  })

  it('output.schema.json equals the generated JSON schema, with no anyOf at its root', () => {
    const file = JSON.parse(readFileSync(`${BRIEF_CHOICES}/output.schema.json`, 'utf8'))
    expect(file).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(briefChoicesResultSchema))))
    expect(file).not.toHaveProperty('anyOf')
  })

  it('the prompt names every choice key', () => {
    const { system } = loadAgentDefinition(BRIEF_CHOICES)
    for (const key of CHOICE_KEYS) expect(system, key).toContain(key)
  })
})
