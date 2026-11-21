import { z } from 'zod'
import { askSchema } from './agent-question.ts'
import { DISALLOWED } from './disallowed.ts'
import {
  CONFIDENCES,
  MAX_FINDINGS,
  MAX_SOURCES,
  PROFILE_KEYS,
  RESEARCH_SOURCE_KINDS,
  WHY_MAX,
} from './research.ts'

// What a question may settle: a profile key, or a strategy input research cannot find (spec 6). Answers on a
// profile key become profile items when the questionnaire is finished.
export const QUESTION_KEYS = [
  ...PROFILE_KEYS,
  'goals',
  'priority_audiences',
  'proof_points',
  'never_say',
  'competitors_not_named',
  'tone_limits',
  'pause_dates',
  'capacity',
  'success_measures',
] as const
export type QuestionKey = (typeof QUESTION_KEYS)[number]
// The answers the safety rules are made from (facts and rules, M8's rule kinds): always asked.
export const SAFETY_KEYS = [
  'never_say',
  'competitors_not_named',
  'tone_limits',
  'pause_dates',
] as const satisfies readonly QuestionKey[]

export const MIN_QUESTIONS = 10
export const MAX_QUESTIONS = 30
const MAX_OPTIONS = 6
const QUESTION_MAX = 300
const OPTION_MAX = 200
const SUGGESTED_MAX = 500
// The input's limits (the brief fixes none): an owner's edited profile value is at most 4,000 characters of JSON.
const VALUE_MAX = 4000
const NAME_MAX = 200
const ADDRESS_MAX = 2000
const MAX_COMPETITORS = 5

// Text the owner will read: not blank, and without the invisible and control characters the payload refuses.
const NOT_VISIBLE = 'is blank or contains an invisible or control character'
const shown = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !DISALLOWED.test(value) && value.trim() !== '', NOT_VISIBLE)
// The input's text came from the owner, research and the web: it is only bounded here, and reaches the model
// wrapped as data.
const given = (max: number) => z.string().min(1).max(max)
const profileKey = z.enum(PROFILE_KEYS)
const confidence = z.enum(CONFIDENCES)

// ---- The questionnaire job's input, built by the core from the draft profile (spec 4, 8.2). ----

export const questionnaireInputSchema = z.strictObject({
  brandName: given(NAME_MAX),
  // The profile the owner accepted: one current item per key.
  profile: z
    .array(z.strictObject({ key: profileKey, value: given(VALUE_MAX), status: confidence }))
    .max(PROFILE_KEYS.length),
  // Profile suggestions the owner has not accepted: undecided or rejected.
  open: z
    .array(z.strictObject({ key: profileKey, proposed: given(VALUE_MAX), confidence }))
    .max(MAX_FINDINGS),
  // The keys the research merge could not settle, with why.
  gaps: z.array(z.strictObject({ key: profileKey, why: given(WHY_MAX) })).max(PROFILE_KEYS.length),
  // The research sources whose result is not `read`; the questionnaire asks about what they would have covered.
  unreadable: z
    .array(z.strictObject({ kind: z.enum(RESEARCH_SOURCE_KINDS), address: given(ADDRESS_MAX).nullable() }))
    .max(MAX_SOURCES),
  // The competitors the owner named at intake.
  competitors: z
    .array(z.strictObject({ name: given(NAME_MAX), website: given(ADDRESS_MAX).nullable() }))
    .max(MAX_COMPETITORS),
})
export type QuestionnaireInput = z.infer<typeof questionnaireInputSchema>

// ---- Its result (questionnaire.v1). ----

const questionSchema = z
  .strictObject({
    key: z.enum(QUESTION_KEYS),
    text: shown(QUESTION_MAX),
    why: shown(WHY_MAX),
    // Multiple choice when there are options; the owner may always write their own answer instead.
    options: z
      .array(shown(OPTION_MAX))
      .max(MAX_OPTIONS)
      .refine((options) => options.length !== 1, { message: 'give no options, or two to six' }),
    suggestedAnswer: shown(SUGGESTED_MAX).nullable(),
  })
  // The suggestion is pre-selected on the owner's screen, so with options it must be one of them.
  .refine(
    (question) =>
      question.options.length === 0 ||
      question.suggestedAnswer === null ||
      question.options.includes(question.suggestedAnswer),
    { message: 'the suggested answer is not one of the options', path: ['suggestedAnswer'] },
  )

// There is no decision field anywhere: only the owner answers. Ruling R7: one strict object, so the provider
// schema has no anyOf at its root; a result either asks (and holds no questions) or holds 10 to 30 questions.
// The prompt aims for 20 to 30; 10 is allowed so a brand whose research settled most of its profile is not
// padded with filler questions.
export const questionnaireResultSchema = z
  .strictObject({
    questions: z
      .array(questionSchema)
      .max(MAX_QUESTIONS)
      // A second question on a key would be answered twice, and its answer would replace the first in the profile.
      .superRefine((questions, ctx) => {
        const seen = new Set<string>()
        questions.forEach((question, i) => {
          if (seen.has(question.key))
            ctx.addIssue({ code: 'custom', path: [i, 'key'], message: 'this key is already asked' })
          seen.add(question.key)
        })
      }),
    ask: askSchema.nullable(),
  })
  .superRefine((result, ctx) => {
    if (result.ask !== null && result.questions.length > 0)
      ctx.addIssue({ code: 'custom', path: ['questions'], message: 'a result that asks holds no questions' })
    if (result.ask === null && result.questions.length < MIN_QUESTIONS)
      ctx.addIssue({
        code: 'custom',
        path: ['questions'],
        message: `at least ${MIN_QUESTIONS} questions, or ask the owner`,
      })
  })
export type QuestionnaireResult = z.infer<typeof questionnaireResultSchema>
