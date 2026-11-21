import { z } from 'zod'
import { askSchema } from './agent-question.ts'
import { MAX_QUESTIONS, QUESTION_KEYS } from './questionnaire.ts'
import { CONFIDENCES, MAX_SOURCES, PROFILE_KEYS, SOURCE_KINDS, WHY_MAX } from './research.ts'
import { shown } from './visible-text.ts'

// M8's safety rule kinds (app.safety_rule_kind).
export const SAFETY_RULE_KINDS = [
  'forbidden_topic',
  'forbidden_claim',
  'forbidden_word',
  'competitor_not_named',
  'tone_limit',
  'pause_dates',
] as const
export type SafetyRuleKind = (typeof SAFETY_RULE_KINDS)[number]

export const MAX_FACTS = 40
export const MAX_RULES = 30
const STATEMENT_MAX = 300
const RULE_TEXT_MAX = 300
// The input's limits (the brief fixes none). Sources: five research groups of at most 60 each, the answers'
// owner statements and the brand's documents. An extract is research's (at most 500 characters) or an owner
// statement's exact wording, which is never cut: an answer is at most 2,000 characters, an owner's edited
// profile value at most 4,000.
const MAX_INPUT_SOURCES = 400
const EXTRACT_MAX = 4000
const VALUE_MAX = 4000
const NAME_MAX = 200
const ADDRESS_MAX = 2000
const DOCUMENT_NAME_MAX = 255
const QUESTION_MAX = 300
const ANSWER_MAX = 2000

// The input's text came from the owner, research and the web: it is only bounded here, and reaches the model
// wrapped as data.
const given = (max: number) => z.string().min(1).max(max)

// ---- The facts and rules job's input, built by the core once the questionnaire is finished (spec 7, 8.2). ----

export const factsRulesInputSchema = z
  .strictObject({
    // The core's date: review dates count from it.
    today: z.iso.date(),
    brandName: given(NAME_MAX),
    // Every source the profile items and the answers cite, and the brand's document sources.
    sources: z
      .array(
        z.strictObject({
          id: z.uuid(),
          kind: z.enum(SOURCE_KINDS),
          address: given(ADDRESS_MAX).nullable(),
          documentName: given(DOCUMENT_NAME_MAX).nullable(),
          extract: given(EXTRACT_MAX),
        }),
      )
      .max(MAX_INPUT_SOURCES),
    // The profile the owner accepted: one current item per key.
    profile: z
      .array(
        z.strictObject({
          key: z.enum(PROFILE_KEYS),
          value: given(VALUE_MAX),
          status: z.enum(CONFIDENCES),
          sourceIds: z.array(z.uuid()).max(MAX_SOURCES),
        }),
      )
      .max(PROFILE_KEYS.length),
    // The finished questionnaire's non-blank answers, each with the owner statement that records it (D7).
    answers: z
      .array(
        z.strictObject({
          key: z.enum(QUESTION_KEYS),
          question: given(QUESTION_MAX),
          answer: given(ANSWER_MAX),
          sourceId: z.uuid(),
        }),
      )
      .max(MAX_QUESTIONS),
  })
  // A fact or rule may cite only the input's sources, so everything the input itself cites is listed, once.
  .superRefine((input, ctx) => {
    const listed = new Set<string>()
    input.sources.forEach((source, i) => {
      if (listed.has(source.id))
        ctx.addIssue({ code: 'custom', path: ['sources', i, 'id'], message: 'two sources share this id' })
      listed.add(source.id)
    })
    const notListed = 'not one of the listed sources'
    input.profile.forEach((item, i) =>
      item.sourceIds.forEach((id, j) => {
        if (!listed.has(id))
          ctx.addIssue({ code: 'custom', path: ['profile', i, 'sourceIds', j], message: notListed })
      }),
    )
    input.answers.forEach((answer, i) => {
      if (!listed.has(answer.sourceId))
        ctx.addIssue({ code: 'custom', path: ['answers', i, 'sourceId'], message: notListed })
    })
  })
export type FactsRulesInput = z.infer<typeof factsRulesInputSchema>

// ---- Its result (facts_rules.v1). ----

// Every fact and every rule cites at least one source (test 44). Which kinds can stand behind a verified fact
// is the core's rule when the owner accepts (M8 qualifiesAsFactSource), not this schema's.
const cited = z.array(z.uuid()).min(1).max(MAX_SOURCES)

// There is no decision field anywhere: only the owner confirms a fact or a rule (test 43). Ruling R7: one
// strict object, so the provider schema has no anyOf at its root; a result either asks (and holds no facts or
// rules) or holds up to 40 facts and 30 rules.
export const factsRulesResultSchema = z
  .strictObject({
    facts: z
      .array(
        z.strictObject({
          statement: shown(STATEMENT_MAX),
          why: shown(WHY_MAX),
          sourceIds: cited,
          // A real calendar date; that it is after the input's today is checked against the input (below).
          reviewDate: z.iso.date(),
        }),
      )
      .max(MAX_FACTS),
    rules: z
      .array(
        z.strictObject({
          kind: z.enum(SAFETY_RULE_KINDS),
          text: shown(RULE_TEXT_MAX),
          why: shown(WHY_MAX),
          sourceIds: cited,
        }),
      )
      .max(MAX_RULES),
    ask: askSchema.nullable(),
  })
  .superRefine((result, ctx) => {
    if (result.ask === null) return
    const message = 'a result that asks holds no facts or rules'
    if (result.facts.length > 0) ctx.addIssue({ code: 'custom', path: ['facts'], message })
    if (result.rules.length > 0) ctx.addIssue({ code: 'custom', path: ['rules'], message })
  })
export type FactsRulesResult = z.infer<typeof factsRulesResultSchema>

// What the result schema cannot see: every cited id is one of the job input's sources, and every review date is
// after the input's today. The core refuses a result with any of these (Task 7); the evaluation fails one.
export function factsRulesAgainstInput(
  result: FactsRulesResult,
  input: { today: string; sources: { id: string }[] },
): { path: (string | number)[]; message: string }[] {
  const listed = new Set(input.sources.map((source) => source.id))
  const issues: { path: (string | number)[]; message: string }[] = []
  const outside = (path: (string | number)[], ids: string[]) =>
    ids.forEach((id, j) => {
      if (!listed.has(id))
        issues.push({ path: [...path, 'sourceIds', j], message: 'not one of the input sources' })
    })
  result.facts.forEach((fact, i) => {
    outside(['facts', i], fact.sourceIds)
    // Both are YYYY-MM-DD, so they compare as text.
    if (fact.reviewDate <= input.today)
      issues.push({ path: ['facts', i, 'reviewDate'], message: 'the review date is not after today' })
  })
  result.rules.forEach((rule, i) => outside(['rules', i], rule.sourceIds))
  return issues
}
