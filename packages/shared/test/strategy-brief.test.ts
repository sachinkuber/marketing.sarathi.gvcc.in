import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BASELINE_NEEDED,
  contentPayloadSchema,
  strategistInputSchema,
  strategyBriefAgainstInput,
  strategyBriefPayload,
  strategyBriefResultSchema,
} from '../src/index.ts'

const F1 = '00000000-0000-4000-8000-0000000000f1'
const F2 = '00000000-0000-4000-8000-0000000000f2'
const F3 = '00000000-0000-4000-8000-0000000000f3'
const HASH1 = '1'.repeat(64)
const HASH2 = 'a'.repeat(64)

const input = {
  brandName: 'Lumen Shield Coatings',
  profile: [{ key: 'business_name', value: 'Lumen Shield Coatings', status: 'found' }],
  facts: [
    { id: F1, statement: 'We coat cars in Pune.' },
    { id: F2, statement: 'Every coating carries a five year warranty.' },
  ],
  rules: [],
  answers: [],
  today: '2026-11-22',
  picks: [
    { key: 'lead_audience', question: 'Who first?', picked: 'Car owners', notTaken: ['Fleet managers'] },
  ],
  baseline: null,
  changeRequest: null,
}
const theme = (n: number) => ({
  name: `Theme ${n}`,
  why: `Why theme ${n}.`,
  topics: [`Topic ${n}a`, `Topic ${n}b`],
})
const brief = () => ({
  positioning: {
    statement: 'Paint protection that lasts.',
    paragraph: 'Lumen Shield protects paint for years.',
  },
  audiences: [
    { name: 'Car owners', needs: 'Lasting shine', message: 'Five year warranty', where: 'Instagram' },
    { name: 'Fleet managers', needs: 'Low upkeep', message: 'Fewer washes', where: 'LinkedIn' },
  ],
  themes: [theme(1), theme(2), theme(3), theme(4)],
  channels: [
    { channel: 'Instagram', audiences: ['Car owners'], why: 'They look there.' },
    { channel: 'LinkedIn', audiences: ['Fleet managers'], why: 'Buyers are there.' },
  ],
  cadence: [
    { channel: 'Instagram', postsPerWeek: 3 },
    { channel: 'LinkedIn', postsPerWeek: 1 },
  ],
  goals: [{ metric: 'Enquiries a month', from: BASELINE_NEEDED, to: '20' }],
  choicesMade: [{ key: 'lead_audience', picked: 'Car owners', notTaken: ['Fleet managers'] }],
  factIds: [F2, F1],
})
const result = (over: Record<string, unknown> = {}) => ({ brief: brief(), ask: null, ...over })
const ask = { text: 'What do you sell?', why: 'Nothing is known.', options: [], suggested: null }
const ctx = {
  brandId: '00000000-0000-4000-8000-00000000000a',
  contentItemId: '00000000-0000-4000-8000-0000000000c1',
  brandName: 'Lumen Shield Coatings',
  facts: [
    { id: F1, statement: 'We coat cars in Pune.', factHash: HASH1 },
    { id: F2, statement: 'Every coating carries a five year warranty.', factHash: HASH2 },
  ],
}

describe('strategist input', () => {
  it('accepts an input and refuses a malformed one', () => {
    expect(strategistInputSchema.safeParse(input).success).toBe(true)
    expect(strategistInputSchema.safeParse({ ...input, picks: [] }).success).toBe(false)
    expect(strategistInputSchema.safeParse({ ...input, today: '22/11/2026' }).success).toBe(false)
    expect(
      strategistInputSchema.safeParse({ ...input, changeRequest: { comment: 'Shorter', previous: '{}' } })
        .success,
    ).toBe(true)
  })
})

describe('strategy brief result', () => {
  it('accepts a brief and refuses breaches of its limits', () => {
    expect(strategyBriefResultSchema.safeParse(result()).success).toBe(true)
    const b = brief()
    expect(strategyBriefResultSchema.safeParse(result({ brief: { ...b, themes: [theme(1)] } })).success).toBe(
      false,
    )
    expect(strategyBriefResultSchema.safeParse(result({ brief: { ...b, factIds: [F1, F1] } })).success).toBe(
      false,
    )
    expect(strategyBriefResultSchema.safeParse(result({ brief: { ...b, factIds: [] } })).success).toBe(false)
    expect(
      strategyBriefResultSchema.safeParse(
        result({ brief: { ...b, cadence: [{ channel: 'X', postsPerWeek: 22 }] } }),
      ).success,
    ).toBe(false)
  })

  it('a result that asks holds nothing else', () => {
    expect(strategyBriefResultSchema.safeParse({ brief: null, ask }).success).toBe(true)
    expect(strategyBriefResultSchema.safeParse({ brief: brief(), ask }).success).toBe(false)
    expect(strategyBriefResultSchema.safeParse({ brief: null, ask: null }).success).toBe(false)
  })

  it('output schema: no anyOf at its root, ask may be null', () => {
    const schema = JSON.parse(JSON.stringify(z.toJSONSchema(strategyBriefResultSchema)))
    expect(schema).not.toHaveProperty('anyOf')
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['brief', 'ask'])
    expect(schema.properties.ask.anyOf).toContainEqual({ type: 'null' })
  })
})

describe('strategyBriefAgainstInput', () => {
  const parsed = (over: Record<string, unknown> = {}) => strategyBriefResultSchema.parse(result(over))
  const withBaseline = { ...input, baseline: '5 enquiries a month' }

  it('accepts a brief that agrees with its input', () => {
    expect(strategyBriefAgainstInput(parsed(), strategistInputSchema.parse(input))).toEqual([])
  })

  it('a brief citing a fact outside the input is reported', () => {
    const r = parsed({ brief: { ...brief(), factIds: [F1, F3] } })
    const errors = strategyBriefAgainstInput(r, strategistInputSchema.parse(input))
    expect(errors).toHaveLength(1)
    expect(errors[0]?.path).toBe('brief.factIds.1')
  })

  it('a choice made that was not picked is reported', () => {
    const b = { ...brief(), choicesMade: [{ key: 'goal_focus', picked: 'x', notTaken: [] }] }
    expect(strategyBriefAgainstInput(parsed({ brief: b }), strategistInputSchema.parse(input))).toHaveLength(
      1,
    )
  })

  it('goals keep "baseline needed (B1)" while no baseline is given', () => {
    const b = { ...brief(), goals: [{ metric: 'Enquiries', from: '5', to: '20' }] }
    const r = parsed({ brief: b })
    expect(strategyBriefAgainstInput(r, strategistInputSchema.parse(input))).toHaveLength(1)
    expect(strategyBriefAgainstInput(r, strategistInputSchema.parse(withBaseline))).toEqual([])
  })

  it('has nothing to report on a result that asks', () => {
    const r = strategyBriefResultSchema.parse({ brief: null, ask })
    expect(strategyBriefAgainstInput(r, strategistInputSchema.parse(input))).toEqual([])
  })
})

describe('strategyBriefPayload', () => {
  const b = () => strategyBriefResultSchema.parse(result()).brief!

  it('the payload lists every section and its fact_refs carry the sha256 text hash', () => {
    const p = strategyBriefPayload(b(), ctx)
    expect(p.kind).toBe('strategy_brief')
    expect(p.language).toBe('en')
    expect(p.title).toBe('Strategy brief: Lumen Shield Coatings')
    expect(p.summary).toBe('Paint protection that lasts.')
    const headings = p.body
      .filter((x) => x.type === 'heading')
      .map((x) => (x.type === 'heading' ? [x.level, x.text] : []))
    expect(headings).toEqual([
      [2, 'Positioning'],
      [2, 'Audiences'],
      [3, 'Car owners'],
      [3, 'Fleet managers'],
      [2, 'Content themes'],
      [3, 'Theme 1'],
      [3, 'Theme 2'],
      [3, 'Theme 3'],
      [3, 'Theme 4'],
      [2, 'Channels'],
      [2, 'Plan: posts per week'],
      [2, '90-day goals'],
      [2, 'Choices made'],
      [2, 'Facts used'],
    ])
    const lists = p.body.filter((x) => x.type === 'list').map((x) => (x.type === 'list' ? x.items : []))
    expect(lists).toContainEqual([
      'Needs: Lasting shine',
      'Tell them: Five year warranty',
      'Where: Instagram',
    ])
    expect(lists).toContainEqual([
      'Instagram: Car owners. They look there.',
      'LinkedIn: Fleet managers. Buyers are there.',
    ])
    expect(lists).toContainEqual(['Instagram: 3 a week', 'LinkedIn: 1 a week'])
    expect(lists).toContainEqual([`Enquiries a month: from ${BASELINE_NEEDED} to 20`])
    expect(lists).toContainEqual(['Car owners (not taken: Fleet managers)'])
    // facts in factIds order
    expect(lists[lists.length - 1]).toEqual([
      'Every coating carries a five year warranty.',
      'We coat cars in Pune.',
    ])
    expect(p.fact_refs).toEqual([
      { fact_id: F2, text_hash: 'sha256:' + HASH2 },
      { fact_id: F1, text_hash: 'sha256:' + HASH1 },
    ])
    for (const ref of p.fact_refs ?? []) expect(ref.text_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('leaves out Choices made when there are none, and a choice with nothing declined stands alone', () => {
    const none = { ...b(), choicesMade: [] }
    const p = strategyBriefPayload(none, ctx)
    expect(p.body.some((x) => x.type === 'heading' && x.text === 'Choices made')).toBe(false)
    const plain = {
      ...b(),
      choicesMade: [{ key: 'lead_audience' as const, picked: 'Car owners', notTaken: [] }],
    }
    const lists = strategyBriefPayload(plain, ctx).body.map((x) => (x.type === 'list' ? x.items : []))
    expect(lists).toContainEqual(['Car owners'])
  })

  it('a payload passes contentPayloadSchema', () => {
    expect(contentPayloadSchema.safeParse(strategyBriefPayload(b(), ctx)).success).toBe(true)
  })

  it('is pure: the same brief gives the same payload', () => {
    expect(strategyBriefPayload(b(), ctx)).toEqual(strategyBriefPayload(b(), ctx))
  })

  it('throws for a fact id with no entry in the context', () => {
    expect(() => strategyBriefPayload(b(), { ...ctx, facts: [ctx.facts[0]!] })).toThrow()
  })
})
