import { z } from 'zod'
import { askSchema } from './agent-question.ts'
import { SAFETY_RULE_KINDS } from './facts-rules.ts'
import { given } from './input-text.ts'
import { QUESTION_KEYS } from './questionnaire.ts'
import { CONFIDENCES, PROFILE_KEYS } from './research.ts'
import { shown } from './visible-text.ts'

// The open strategic choices the owner settles before the brief is written (spec 10).
export const CHOICE_KEYS = [
  'lead_audience',
  'positioning_angle',
  'first_channels',
  'content_focus',
  'posting_rhythm',
  'goal_focus',
] as const
export type ChoiceKey = (typeof CHOICE_KEYS)[number]

// What a goal's starting value says while the owner has given no baseline.
export const BASELINE_NEEDED = 'baseline needed (B1)'

const MIN_CHOICES = 3
const MAX_OPTIONS = 3

// ---- The brief_choices job's input, built by the core from the accepted profile, facts, rules and answers. ----

export const briefChoicesInputSchema = z.strictObject({
  brandName: given(200),
  profile: z
    .array(
      z.strictObject({
        key: z.enum(PROFILE_KEYS),
        value: given(2000),
        status: z.enum(CONFIDENCES),
      }),
    )
    .max(40),
  facts: z
    .array(z.strictObject({ id: z.uuid(), statement: given(1000) }))
    .min(1)
    .max(60),
  rules: z.array(z.strictObject({ kind: z.enum(SAFETY_RULE_KINDS), text: given(1000) })).max(60),
  answers: z
    .array(z.strictObject({ key: z.enum(QUESTION_KEYS), question: given(300), answer: given(2000) }))
    .max(30),
})
export type BriefChoicesInput = z.infer<typeof briefChoicesInputSchema>

// ---- Its result (brief_choices.v1). Ruling R7: one strict object, `ask` is null unless the agent asks. ----

const choiceSchema = z.strictObject({
  key: z.enum(CHOICE_KEYS),
  question: shown(300),
  why: shown(300),
  options: z
    .array(
      z.strictObject({
        value: shown(200),
        tradeOff: shown(300),
        recommended: z.boolean(),
      }),
    )
    .min(2)
    .max(MAX_OPTIONS),
})

export const briefChoicesResultSchema = z
  .strictObject({
    choices: z.array(choiceSchema).max(CHOICE_KEYS.length),
    ask: askSchema.nullable(),
  })
  .superRefine((result, ctx) => {
    if (result.ask !== null) {
      if (result.choices.length > 0)
        ctx.addIssue({ code: 'custom', path: ['choices'], message: 'a result that asks holds no choices' })
      return
    }
    if (result.choices.length < MIN_CHOICES)
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: `at least ${MIN_CHOICES} choices, or ask the owner`,
      })
    const keys = new Set<string>()
    result.choices.forEach((choice, i) => {
      if (keys.has(choice.key))
        ctx.addIssue({ code: 'custom', path: ['choices', i, 'key'], message: 'this key is already asked' })
      keys.add(choice.key)
      if (choice.options.filter((option) => option.recommended).length !== 1)
        ctx.addIssue({
          code: 'custom',
          path: ['choices', i, 'options'],
          message: 'exactly one option is recommended',
        })
      const values = new Set<string>()
      choice.options.forEach((option, j) => {
        const value = option.value.trim().toLowerCase()
        if (values.has(value))
          ctx.addIssue({
            code: 'custom',
            path: ['choices', i, 'options', j, 'value'],
            message: 'the options must differ',
          })
        values.add(value)
      })
    })
  })
export type BriefChoicesResult = z.infer<typeof briefChoicesResultSchema>
