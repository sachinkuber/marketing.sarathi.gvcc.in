import { z } from 'zod'
import { DISALLOWED } from './disallowed.ts'

// What the onboarding research fills in: the brand profile's keys, in the order the owner reads them.
export const PROFILE_KEYS = [
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
] as const
export type ProfileKey = (typeof PROFILE_KEYS)[number]

// One research job per group (spec 6), so one failing source does not fail the others.
export const SOURCE_GROUPS = ['site', 'social', 'visibility', 'competitors', 'documents'] as const
export type SourceGroup = (typeof SOURCE_GROUPS)[number]

// The source kinds research may record: the database's app.source_kind without owner_statement, which only the
// owner's own word makes (D7). Likewise 'stated' is the owner's result and never research's.
export const RESEARCH_SOURCE_KINDS = ['site', 'social', 'search', 'document', 'competitor'] as const
export type ResearchSourceKind = (typeof RESEARCH_SOURCE_KINDS)[number]
export const RESEARCH_RESULTS = ['read', 'blocked', 'empty', 'error'] as const
export const CONFIDENCES = ['found', 'assumed', 'unknown'] as const

export const MAX_SOURCES = 60
export const MAX_FINDINGS = 40
export const EXTRACT_MAX = 500
export const WHY_MAX = 300
// Builder's limits (the brief fixes none): a profile value, a flag's reason, an address, a competitor's name.
export const PROPOSED_MAX = 500
const REASON_MAX = 300
const ADDRESS_MAX = 2000
const NAME_MAX = 200
const MAX_COMPETITORS = 5
const MAX_DOCUMENTS = 20

// Text the owner will read: not blank, and without the invisible and control characters the payload refuses.
const NOT_VISIBLE = 'is blank or contains an invisible or control character'
const shown = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !DISALLOWED.test(value) && value.trim() !== '', NOT_VISIBLE)
const address = z
  .string()
  .min(1)
  .max(ADDRESS_MAX)
  .refine((value) => !DISALLOWED.test(value), NOT_VISIBLE)
const webAddress = z.url({ protocol: /^https?$/ }).max(ADDRESS_MAX)
const profileKey = z.enum(PROFILE_KEYS)
const confidence = z.enum(CONFIDENCES)
const flagged = z.strictObject({ reason: shown(REASON_MAX) }).nullable()
const sourceRef = z.string().regex(/^s[0-9]{1,3}$/)
const notSettled = z.strictObject({ key: profileKey, why: shown(WHY_MAX) })

// ---- A research group job: its input and its result (research_group.v1). ----

export const researchGroupInputSchema = z.strictObject({
  group: z.enum(SOURCE_GROUPS),
  intake: z.strictObject({
    website: webAddress,
    socials: z.strictObject({
      instagram: webAddress.optional(),
      facebook: webAddress.optional(),
      linkedin: webAddress.optional(),
      youtube: webAddress.optional(),
    }),
    competitors: z
      .array(z.strictObject({ name: shown(NAME_MAX), website: webAddress.optional() }))
      .max(MAX_COMPETITORS),
  }),
  documentIds: z.array(z.uuid()).max(MAX_DOCUMENTS).optional(),
})
export type ResearchGroupInput = z.infer<typeof researchGroupInputSchema>

export const researchGroupResultSchema = z
  .strictObject({
    group: z.enum(SOURCE_GROUPS),
    sources: z
      .array(
        z.strictObject({
          ref: sourceRef,
          kind: z.enum(RESEARCH_SOURCE_KINDS),
          address: address.nullable(),
          documentId: z.uuid().nullable(),
          result: z.enum(RESEARCH_RESULTS),
          extract: shown(EXTRACT_MAX),
          flagged,
        }),
      )
      .max(MAX_SOURCES),
    findings: z
      .array(
        z.strictObject({
          key: profileKey,
          proposed: shown(PROPOSED_MAX),
          why: shown(WHY_MAX),
          // A finding rests on at least one source: a key nothing states goes in `unsettled`.
          sourceRefs: z.array(sourceRef).min(1).max(MAX_SOURCES),
          confidence,
          conflict: z.boolean(),
        }),
      )
      .max(MAX_FINDINGS),
    unsettled: z.array(notSettled).max(PROFILE_KEYS.length),
  })
  .superRefine((value, ctx) => {
    // The core turns each ref into a stored source: a ref must be unique, a finding may cite only listed refs,
    // and a source must say where it was read (a document by its id, anything else by its address).
    const refs = new Set<string>()
    value.sources.forEach((source, i) => {
      if (refs.has(source.ref))
        ctx.addIssue({ code: 'custom', path: ['sources', i, 'ref'], message: 'two sources share this ref' })
      refs.add(source.ref)
      if (source.kind === 'document' && source.documentId === null)
        ctx.addIssue({
          code: 'custom',
          path: ['sources', i, 'documentId'],
          message: 'a document needs its id',
        })
      if (source.kind !== 'document' && source.address === null)
        ctx.addIssue({ code: 'custom', path: ['sources', i, 'address'], message: 'a page needs its address' })
    })
    value.findings.forEach((finding, i) =>
      finding.sourceRefs.forEach((ref, j) => {
        if (!refs.has(ref))
          ctx.addIssue({
            code: 'custom',
            path: ['findings', i, 'sourceRefs', j],
            message: 'not a listed source',
          })
      }),
    )
  })
export type ResearchGroupResult = z.infer<typeof researchGroupResultSchema>

// ---- The merge job: its input (every group's stored sources and findings) and its result (research.v1). ----

export const researchMergeInputSchema = z.strictObject({
  groups: z
    .array(
      z
        .strictObject({
          group: z.enum(SOURCE_GROUPS),
          sources: z
            .array(
              z.strictObject({
                id: z.uuid(),
                kind: z.enum(RESEARCH_SOURCE_KINDS),
                address: address.nullable(),
                result: z.enum(RESEARCH_RESULTS),
                extract: shown(EXTRACT_MAX),
                flagged,
              }),
            )
            .max(MAX_SOURCES),
          findings: z
            .array(
              z.strictObject({
                key: profileKey,
                proposed: shown(PROPOSED_MAX),
                why: shown(WHY_MAX),
                sourceIds: z.array(z.uuid()).min(1).max(MAX_SOURCES),
                confidence,
                conflict: z.boolean(),
              }),
            )
            .max(MAX_FINDINGS),
        })
        .superRefine((group, ctx) => {
          const ids = new Set(group.sources.map((source) => source.id))
          group.findings.forEach((finding, i) =>
            finding.sourceIds.forEach((id, j) => {
              if (!ids.has(id))
                ctx.addIssue({
                  code: 'custom',
                  path: ['findings', i, 'sourceIds', j],
                  message: "not one of this group's sources",
                })
            }),
          )
        }),
    )
    .max(SOURCE_GROUPS.length),
  deadGroups: z.array(z.enum(SOURCE_GROUPS)).max(SOURCE_GROUPS.length),
})
export type ResearchMergeInput = z.infer<typeof researchMergeInputSchema>

// There is no decision field anywhere: only the owner decides, so a result that tries to is refused (test 43).
export const researchResultSchema = z.strictObject({
  suggestions: z
    .array(
      z.strictObject({
        key: profileKey,
        proposed: shown(PROPOSED_MAX),
        why: shown(WHY_MAX),
        // A suggestion rests on at least one source: a key with none is a gap.
        sourceIds: z.array(z.uuid()).min(1).max(MAX_SOURCES),
        confidence,
        options: z
          .array(
            z.strictObject({
              value: shown(PROPOSED_MAX),
              tradeOff: shown(WHY_MAX),
              recommended: z.boolean(),
            }),
          )
          .min(2)
          .max(3)
          // JSON Schema as the provider takes it cannot say this; the result is checked here.
          .refine((options) => options.filter((option) => option.recommended).length === 1, {
            message: 'exactly one option is recommended',
          })
          .optional(),
      }),
    )
    .max(MAX_FINDINGS)
    // A suggestion supersedes an undecided one with the same key (addSuggestions), so a second suggestion for
    // a key in the same result would hide the first.
    .superRefine((suggestions, ctx) => {
      const seen = new Set<string>()
      suggestions.forEach((suggestion, i) => {
        if (seen.has(suggestion.key))
          ctx.addIssue({ code: 'custom', path: [i, 'key'], message: 'this key is already suggested' })
        seen.add(suggestion.key)
      })
    }),
  gaps: z.array(notSettled).max(PROFILE_KEYS.length),
})
export type ResearchResult = z.infer<typeof researchResultSchema>
