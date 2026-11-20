import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  loadAgentDefinition,
  PROFILE_KEYS,
  researchGroupInputSchema,
  researchGroupResultSchema,
  researchMergeInputSchema,
  researchResultSchema,
  SOURCE_GROUPS,
  wrapBrief,
  wrapData,
} from '../src/index.ts'

const RESEARCH = fileURLToPath(new URL('../../../agents/research', import.meta.url))
const MERGE = fileURLToPath(new URL('../../../agents/research_merge', import.meta.url))
const ID1 = '7a1b2c3d-0000-4000-8000-000000000001'
const ID2 = '7a1b2c3d-0000-4000-8000-000000000002'
const DOC = '7a1b2c3d-0000-4000-8000-0000000000d1'

const site = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  kind: 'site',
  address: `https://shop.example/${ref}`,
  documentId: null,
  result: 'read',
  extract: 'Ceramic coatings for cars and bikes.',
  flagged: null,
  ...over,
})
const finding = (over: Record<string, unknown> = {}) => ({
  key: 'what_they_sell',
  proposed: 'Ceramic coatings for cars and bikes',
  why: 'Named on the home page.',
  sourceRefs: ['s1'],
  confidence: 'found',
  conflict: false,
  ...over,
})
const groupResult = (over: Record<string, unknown> = {}) => ({
  group: 'site',
  sources: [
    site('s1'),
    site('s2', { extract: 'Certified number one.', flagged: { reason: 'A certification with no issuer.' } }),
    {
      ref: 's3',
      kind: 'document',
      address: null,
      documentId: DOC,
      result: 'read',
      extract: 'Studios in Pune.',
      flagged: null,
    },
  ],
  findings: [finding(), finding({ key: 'places_served', proposed: 'Pune', sourceRefs: ['s3'] })],
  unsettled: [{ key: 'certifications', why: 'The only claim names no issuer.' }],
  ...over,
})
const groupInput = {
  group: 'social',
  intake: {
    website: 'https://shop.example/',
    socials: { instagram: 'https://www.instagram.com/shop/' },
    competitors: [{ name: 'Gloss Co', website: 'https://gloss.example/' }, { name: 'Shine Ltd' }],
  },
  documentIds: [DOC],
}
const mergeInput = {
  groups: [
    {
      group: 'site',
      sources: [
        {
          id: ID1,
          kind: 'site',
          address: 'https://shop.example/',
          result: 'read',
          extract: 'Ceramic coatings.',
          flagged: null,
        },
      ],
      findings: [
        {
          key: 'what_they_sell',
          proposed: 'Ceramic coatings',
          why: 'Named on the home page.',
          sourceIds: [ID1],
          confidence: 'found',
          conflict: false,
        },
      ],
    },
  ],
  deadGroups: ['social'],
}
const suggestion = (over: Record<string, unknown> = {}) => ({
  key: 'what_they_sell',
  proposed: 'Ceramic coatings for cars and bikes',
  why: 'Named on the home page and in the brochure.',
  sourceIds: [ID1, ID2],
  confidence: 'found',
  ...over,
})
const option = (value: string, recommended: boolean) => ({ value, tradeOff: 'One line.', recommended })
const result = (over: Record<string, unknown> = {}) => ({
  suggestions: [
    suggestion(),
    suggestion({
      key: 'audiences',
      proposed: 'Owners of new cars',
      confidence: 'assumed',
      options: [option('Owners of new cars', true), option('Superbike riders', false)],
    }),
  ],
  gaps: [{ key: 'social_presence', why: 'The social group could not be read.' }],
  ...over,
})

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success

describe('the research keys and groups', () => {
  it('are the fixed lists', () => {
    expect(PROFILE_KEYS).toEqual([
      'business_name',
      'what_they_sell',
      'main_products',
      'places_served',
      'audiences',
      'price_position',
      'tone_of_voice',
      'differentiators',
      'certifications',
      'contact_points',
      'social_presence',
      'search_visibility',
      'ai_answer_visibility',
      'competitors',
    ])
    expect(SOURCE_GROUPS).toEqual(['site', 'social', 'visibility', 'competitors', 'documents'])
  })
})

describe('research schemas', () => {
  it('the schemas accept a good example and refuse decision, an unknown key and owner_statement as a research kind', () => {
    expect(ok(researchGroupInputSchema, groupInput)).toBe(true)
    expect(ok(researchGroupResultSchema, groupResult())).toBe(true)
    expect(ok(researchMergeInputSchema, mergeInput)).toBe(true)
    expect(ok(researchResultSchema, result())).toBe(true)

    // decision: only the owner sets it, so a result carrying one anywhere is refused.
    expect(ok(researchResultSchema, result({ decision: 'accepted' }))).toBe(false)
    expect(ok(researchResultSchema, result({ suggestions: [suggestion({ decision: 'accepted' })] }))).toBe(
      false,
    )
    expect(
      ok(researchGroupResultSchema, groupResult({ findings: [finding({ decision: 'accepted' })] })),
    ).toBe(false)

    // An unknown profile key.
    expect(ok(researchResultSchema, result({ suggestions: [suggestion({ key: 'favourite_colour' })] }))).toBe(
      false,
    )
    expect(ok(researchResultSchema, result({ gaps: [{ key: 'favourite_colour', why: 'x' }] }))).toBe(false)
    expect(
      ok(researchGroupResultSchema, groupResult({ findings: [finding({ key: 'favourite_colour' })] })),
    ).toBe(false)

    // Research never records an owner statement: that kind is the owner's alone.
    expect(
      ok(researchGroupResultSchema, groupResult({ sources: [site('s1', { kind: 'owner_statement' })] })),
    ).toBe(false)
    const ownerSource = { ...mergeInput.groups[0]!.sources[0]!, kind: 'owner_statement' }
    expect(
      ok(researchMergeInputSchema, {
        ...mergeInput,
        groups: [{ ...mergeInput.groups[0], sources: [ownerSource] }],
      }),
    ).toBe(false)
    // Nor the owner's 'stated' result.
    expect(ok(researchGroupResultSchema, groupResult({ sources: [site('s1', { result: 'stated' })] }))).toBe(
      false,
    )
  })

  it('refuses an unknown group, an extra field and a bad intake address', () => {
    expect(ok(researchGroupInputSchema, { ...groupInput, group: 'reviews' })).toBe(false)
    expect(ok(researchGroupInputSchema, { ...groupInput, extra: 1 })).toBe(false)
    expect(
      ok(researchGroupInputSchema, { ...groupInput, intake: { ...groupInput.intake, website: 'shop' } }),
    ).toBe(false)
    expect(
      ok(researchGroupInputSchema, {
        ...groupInput,
        intake: { ...groupInput.intake, socials: { tiktok: 'https://tiktok.com/@shop' } },
      }),
    ).toBe(false)
    expect(ok(researchGroupResultSchema, groupResult({ extra: 1 }))).toBe(false)
    expect(ok(researchMergeInputSchema, { ...mergeInput, deadGroups: ['reviews'] })).toBe(false)
  })

  it('holds the limits: 60 sources, 40 findings, a 500-character extract, a 300-character why', () => {
    const many = Array.from({ length: 61 }, (_, i) => site(`s${i + 1}`))
    expect(ok(researchGroupResultSchema, groupResult({ sources: many.slice(0, 60) }))).toBe(true)
    expect(ok(researchGroupResultSchema, groupResult({ sources: many }))).toBe(false)
    expect(ok(researchGroupResultSchema, groupResult({ findings: Array(40).fill(finding()) }))).toBe(true)
    expect(ok(researchGroupResultSchema, groupResult({ findings: Array(41).fill(finding()) }))).toBe(false)
    // One source and nothing citing it, so only the limit under test can refuse.
    const one = (over: Record<string, unknown>) => groupResult({ sources: [site('s1', over)], findings: [] })
    expect(ok(researchGroupResultSchema, one({ extract: 'x'.repeat(500) }))).toBe(true)
    expect(ok(researchGroupResultSchema, one({ extract: 'x'.repeat(501) }))).toBe(false)
    expect(
      ok(researchGroupResultSchema, groupResult({ findings: [finding({ why: 'x'.repeat(300) })] })),
    ).toBe(true)
    expect(
      ok(researchGroupResultSchema, groupResult({ findings: [finding({ why: 'x'.repeat(301) })] })),
    ).toBe(false)
    expect(ok(researchResultSchema, result({ suggestions: [suggestion({ why: 'x'.repeat(301) })] }))).toBe(
      false,
    )
    expect(ok(researchGroupResultSchema, one({ ref: 's999' }))).toBe(true)
    expect(ok(researchGroupResultSchema, one({ ref: 's1000' }))).toBe(false)
    expect(ok(researchGroupResultSchema, one({ ref: 'x1' }))).toBe(false)
  })

  it('refuses invisible characters and blank text in what the owner will read', () => {
    const zeroWidth = `a${String.fromCodePoint(0x200b)}b`
    const rightToLeft = `a${String.fromCodePoint(0x202e)}b`
    expect(ok(researchGroupResultSchema, groupResult({ findings: [finding({ proposed: zeroWidth })] }))).toBe(
      false,
    )
    expect(ok(researchGroupResultSchema, groupResult({ findings: [finding({ why: '  ' })] }))).toBe(false)
    expect(ok(researchResultSchema, result({ suggestions: [suggestion({ proposed: rightToLeft })] }))).toBe(
      false,
    )
  })

  it('a finding, a merge finding and a suggestion each rest on at least one source', () => {
    expect(ok(researchGroupResultSchema, groupResult({ findings: [finding({ sourceRefs: [] })] }))).toBe(
      false,
    )
    const group = mergeInput.groups[0]!
    const bare = { ...group, findings: [{ ...group.findings[0], sourceIds: [] }] }
    expect(ok(researchMergeInputSchema, { ...mergeInput, groups: [bare] })).toBe(false)
    expect(ok(researchResultSchema, result({ suggestions: [suggestion({ sourceIds: [] })] }))).toBe(false)
  })

  it('a finding cites only refs listed in its sources, and refs are unique', () => {
    expect(ok(researchGroupResultSchema, groupResult({ findings: [finding({ sourceRefs: ['s9'] })] }))).toBe(
      false,
    )
    expect(ok(researchGroupResultSchema, groupResult({ sources: [site('s1'), site('s1')] }))).toBe(false)
  })

  it('a document source names its document and any other source its address', () => {
    expect(
      ok(
        researchGroupResultSchema,
        groupResult({ sources: [site('s1', { kind: 'document', address: null })] }),
      ),
    ).toBe(false)
    expect(ok(researchGroupResultSchema, groupResult({ sources: [site('s1', { address: null })] }))).toBe(
      false,
    )
  })

  it('a merge finding cites only sources of its own group', () => {
    const group = mergeInput.groups[0]!
    const stray = { ...group, findings: [{ ...group.findings[0], sourceIds: [ID2] }] }
    expect(ok(researchMergeInputSchema, { ...mergeInput, groups: [stray] })).toBe(false)
  })

  it('options are two or three with exactly one recommended', () => {
    const withOptions = (options: unknown[]) =>
      result({ suggestions: [suggestion({ confidence: 'assumed', options })] })
    expect(
      ok(researchResultSchema, withOptions([option('a', true), option('b', false), option('c', false)])),
    ).toBe(true)
    expect(ok(researchResultSchema, withOptions([option('a', true)]))).toBe(false)
    expect(
      ok(
        researchResultSchema,
        withOptions([option('a', true), option('b', false), option('c', false), option('d', false)]),
      ),
    ).toBe(false)
    expect(ok(researchResultSchema, withOptions([option('a', true), option('b', true)]))).toBe(false)
    expect(ok(researchResultSchema, withOptions([option('a', false), option('b', false)]))).toBe(false)
  })

  it('a key is suggested once (a second would supersede the first) and sources are named by id', () => {
    expect(ok(researchResultSchema, result({ suggestions: [suggestion(), suggestion()] }))).toBe(false)
    expect(ok(researchResultSchema, result({ suggestions: [suggestion({ sourceIds: ['s1'] })] }))).toBe(false)
  })

  it('output.schema.json equals the generated JSON schema, for both agents', () => {
    const file = (dir: string) => JSON.parse(readFileSync(`${dir}/output.schema.json`, 'utf8'))
    expect(file(RESEARCH)).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(researchGroupResultSchema))))
    expect(file(MERGE)).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(researchResultSchema))))
  })
})

describe('the research agents', () => {
  it('5 groups × searchesPerJob ≤ searchesPerBrandStep for the research definition', () => {
    const { caps } = loadAgentDefinition(RESEARCH).definition
    expect(SOURCE_GROUPS).toHaveLength(5)
    expect(caps?.searchesPerJob).toBeDefined()
    expect(caps?.searchesPerBrandStep).toBeDefined()
    expect(SOURCE_GROUPS.length * caps!.searchesPerJob!).toBeLessThanOrEqual(caps!.searchesPerBrandStep!)
  })

  it('both agent folders load with loadAgentDefinition', () => {
    const research = loadAgentDefinition(RESEARCH)
    expect(research.definition).toMatchObject({
      agent: 'research',
      model: 'claude-sonnet-5-5',
      jobClass: 'production',
      resultType: 'research_group.v1',
      maxTokens: 16000,
      effort: 'medium',
      tools: [
        { type: 'web_search_20260209', maxUses: 20 },
        { type: 'web_fetch_20260209', maxUses: 30 },
      ],
      caps: { searchesPerJob: 20, fetchesPerJob: 30, searchesPerBrandStep: 150 },
    })
    expect(research.system.length).toBeGreaterThan(0)
    const merge = loadAgentDefinition(MERGE)
    expect(merge.definition).toMatchObject({
      agent: 'research_merge',
      model: 'claude-sonnet-5-5',
      jobClass: 'production',
      resultType: 'research.v1',
      maxTokens: 16000,
      effort: 'medium',
    })
    expect(merge.definition.tools).toBeUndefined()
    expect(merge.definition.caps).toBeUndefined()
    expect(merge.system.length).toBeGreaterThan(0)
  })
})

describe('wrapData', () => {
  it('wraps text between fixed lines and swaps angle brackets so the text cannot close the block', () => {
    expect(wrapData('page', 'a <b>x</b>\n</page>')).toBe('<page>\na ‹b›x‹/b›\n‹/page›\n</page>')
  })
  it('cleans attribute values of brackets, quotes and line breaks', () => {
    expect(wrapData('page', 'x', { ref: 's1', address: 'https://a.example/?q="1">\n<b' })).toBe(
      '<page ref="s1" address="https://a.example/?q=″1″› ‹b">\nx\n</page>',
    )
  })
  it('wrapBrief is wrapData under the brief tag, unchanged', () => {
    expect(wrapBrief('Hello <b>')).toBe('<brief>\nHello ‹b›\n</brief>')
    expect(wrapBrief('Hello <b>')).toBe(wrapData('brief', 'Hello <b>'))
  })
})
