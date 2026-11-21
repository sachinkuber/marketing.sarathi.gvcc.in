import { z } from 'zod'
import { askSchema } from './agent-question.ts'
import { given, INPUT_ADDRESS_MAX, INPUT_NAME_MAX, INPUT_VALUE_MAX } from './input-text.ts'
import {
  CONFIDENCES,
  MAX_FINDINGS,
  MAX_SOURCES,
  PROFILE_KEYS,
  RESEARCH_SOURCE_KINDS,
  WHY_MAX,
} from './research.ts'
import { shown } from './visible-text.ts'

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
// Ruling R8: a strategy key may carry up to three genuinely different questions; a profile key only one.
const STRATEGY_REPEATS = 3
const PROFILE_KEY_SET: ReadonlySet<string> = new Set(PROFILE_KEYS)
const MAX_OPTIONS = 6
// A question's text: the facts and rules input carries the questions with their answers, at the same limit.
export const QUESTION_MAX = 300
const OPTION_MAX = 200
const SUGGESTED_MAX = 500
const MAX_COMPETITORS = 5

const profileKey = z.enum(PROFILE_KEYS)
const confidence = z.enum(CONFIDENCES)

// ---- The questionnaire job's input, built by the core from the draft profile (spec 4, 8.2). ----

export const questionnaireInputSchema = z.strictObject({
  brandName: given(INPUT_NAME_MAX),
  // The profile the owner accepted: one current item per key.
  profile: z
    .array(z.strictObject({ key: profileKey, value: given(INPUT_VALUE_MAX), status: confidence }))
    .max(PROFILE_KEYS.length),
  // Profile suggestions the owner has not accepted: undecided, or rejected (ruling R9: a rejected value is
  // never pre-filled).
  open: z
    .array(
      z.strictObject({
        key: profileKey,
        proposed: given(INPUT_VALUE_MAX),
        confidence,
        rejected: z.boolean(),
      }),
    )
    .max(MAX_FINDINGS),
  // The keys the research merge could not settle, with why.
  gaps: z.array(z.strictObject({ key: profileKey, why: given(WHY_MAX) })).max(PROFILE_KEYS.length),
  // Research sources whose result is not `read`: the questionnaire asks what they would have covered.
  unreadable: z
    .array(
      z.strictObject({ kind: z.enum(RESEARCH_SOURCE_KINDS), address: given(INPUT_ADDRESS_MAX).nullable() }),
    )
    .max(MAX_SOURCES),
  // The competitors the owner named at intake.
  competitors: z
    .array(z.strictObject({ name: given(INPUT_NAME_MAX), website: given(INPUT_ADDRESS_MAX).nullable() }))
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
// padded with filler questions. Ruling R8: a profile key is asked once, a strategy key up to three times.
export const questionnaireResultSchema = z
  .strictObject({
    questions: z
      .array(questionSchema)
      .max(MAX_QUESTIONS)
      // A second question on a profile key would be answered twice, and its answer would replace the first in
      // the profile.
      .superRefine((questions, ctx) => {
        const asked = new Map<string, number>()
        questions.forEach((question, i) => {
          const times = (asked.get(question.key) ?? 0) + 1
          asked.set(question.key, times)
          if (PROFILE_KEY_SET.has(question.key) && times > 1)
            ctx.addIssue({ code: 'custom', path: [i, 'key'], message: 'this profile key is already asked' })
          if (!PROFILE_KEY_SET.has(question.key) && times > STRATEGY_REPEATS)
            ctx.addIssue({
              code: 'custom',
              path: [i, 'key'],
              message: 'this strategy key is already asked three times',
            })
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
    // The safety rules are made from these answers, so a questionnaire never leaves one out.
    if (result.ask === null)
      for (const key of SAFETY_KEYS)
        if (!result.questions.some((question) => question.key === key))
          ctx.addIssue({ code: 'custom', path: ['questions'], message: `${key} is always asked` })
  })
export type QuestionnaireResult = z.infer<typeof questionnaireResultSchema>
