import type { Pool } from '@mkt/db'
import { SAFETY_RULE_KINDS } from '@mkt/shared'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { principalOf } from '../auth/session.ts'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'
import { acceptFound, decideSuggestion, listSuggestions } from '../onboarding/suggestions.ts'
import { answerAgentQuestion, listAgentQuestions } from '../onboarding/agent-questions.ts'
import { inputOf, validate } from '../validate.ts'
import type { JobsDeps } from '../jobs/service.ts'
import { readBriefChoices, startBriefChoices } from '../onboarding/brief-choices.ts'
import {
  addOwnFact,
  addOwnRule,
  OWN_TEXT_MAX,
  readFactsRules,
  replaceFact,
  retireFact,
  startFactsRules,
  turnOffRule,
} from '../onboarding/facts-rules.ts'
import {
  ANSWER_MAX,
  finishQuestionnaire,
  readQuestionnaire,
  saveAnswer,
  startQuestionnaire,
} from '../onboarding/questionnaire.ts'
import { intakeSchema, readOverview, saveIntake, startResearch } from '../onboarding/research.ts'

export interface OnboardingRouteDeps {
  pool: Pool
  audit: AuditSink
  // Present only with the work engine; starting research needs it.
  jobs?: JobsDeps
  // The service's clock, for "after today". Unset: the system clock.
  now?: () => Date
}

const STEPS = ['profile', 'question', 'fact', 'rule', 'choice'] as const
const brandParams = z.strictObject({ brandId: z.uuid() })
const suggestionParams = z.strictObject({ brandId: z.uuid(), suggestionId: z.uuid() })
const listQuery = z.strictObject({ step: z.enum(STEPS).optional() })
const acceptBody = z.strictObject({ step: z.enum(STEPS) })
const questionParams = z.strictObject({ brandId: z.uuid(), questionId: z.uuid() })
// The owner's own words, kept exactly as given once trimmed (an owner statement, D7).
const answerBody = z.strictObject({
  answer: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine((v) => !v.includes('\u0000'), 'must not contain U+0000'),
})

// Saved as typed: at most 2000 characters (the facts agent's input limit); empty deletes the answer.
const savedAnswerBody = z.strictObject({
  value: z
    .string()
    .max(ANSWER_MAX, `An answer can be at most ${ANSWER_MAX} characters.`)
    .refine((v) => !v.includes('\u0000'), 'must not contain U+0000'),
})

// The owner's own fact or rule: their words, kept exactly as given once trimmed (an owner statement, D7).
const ownText = (what: string) =>
  z
    .string()
    .trim()
    .min(1, `${what} must not be empty.`)
    .max(OWN_TEXT_MAX, `${what} can be at most ${OWN_TEXT_MAX} characters.`)
    .refine((v) => !v.includes('\u0000'), 'must not contain U+0000')
// A real calendar date after today (UTC, the service's clock). Any later date is accepted: the owner may review a
// fact after a year or more (ruling R14).
const REVIEW_DATE = 'Give the review date as YYYY-MM-DD, a real date after today.'
const factBodyFor = (now: () => Date) =>
  z.strictObject({
    statement: ownText('The fact'),
    reviewDate: z.iso
      .date({ error: REVIEW_DATE })
      .refine((d) => d > now().toISOString().slice(0, 10), REVIEW_DATE),
  })
type FactBody = z.infer<ReturnType<typeof factBodyFor>>
// "a, b or c"
const orList = (items: readonly string[]) => items.join(', ').replace(/, ([^,]*)$/, ' or $1')
const RULE_KIND = `Choose a kind of rule: ${orList(SAFETY_RULE_KINDS.map((k) => k.replace(/_/g, ' ')))} (sent as ${orList(SAFETY_RULE_KINDS)}).`
const ruleBody = z.strictObject({
  kind: z.enum(SAFETY_RULE_KINDS, { error: RULE_KIND }),
  text: ownText('The rule'),
  why: ownText('The reason'),
})
const factParams = z.strictObject({ brandId: z.uuid(), factId: z.uuid() })
const ruleParams = z.strictObject({ brandId: z.uuid(), ruleId: z.uuid() })

const MAX_VALUE = 4000
const decisionBody = z
  .strictObject({
    decision: z.enum(['accepted', 'edited', 'rejected']),
    value: z.unknown().optional(),
    // A fact confirmed as it stands but reviewed on another date; its wording and sources stay the agent's.
    reviewDate: z.iso.date({ error: REVIEW_DATE }).optional(),
    reason: z.string().max(2000).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.reviewDate !== undefined && b.decision !== 'accepted') {
      ctx.addIssue({
        code: 'custom',
        path: ['reviewDate'],
        message: 'reviewDate is only used with "accepted"',
      })
      return
    }
    if (b.value !== undefined && b.decision !== 'edited') {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'value is only used with "edited"' })
      return
    }
    if (b.value === undefined) {
      if (b.decision === 'edited')
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'An edit needs the new value' })
      return
    }
    const text = JSON.stringify(b.value) ?? ''
    const empty =
      b.value === null ||
      (typeof b.value === 'string' && b.value.trim() === '') ||
      (Array.isArray(b.value) && b.value.length === 0) ||
      (typeof b.value === 'object' && !Array.isArray(b.value) && Object.keys(b.value as object).length === 0)
    if (empty) ctx.addIssue({ code: 'custom', path: ['value'], message: 'The value must not be empty' })
    else if (text.length > MAX_VALUE)
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `The value is too long: at most ${MAX_VALUE} characters`,
      })
  })

export function registerOnboardingRoutes(table: RouteTable, deps: OnboardingRouteDeps): void {
  const factBody = factBodyFor(deps.now ?? (() => new Date()))
  table.add({
    method: 'get',
    path: '/brands/:brandId/onboarding',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary:
      'Where onboarding stands: the step, the intake, and for each research group its state, searches, page reads, cost and sources',
    handlers: [
      validate({ params: brandParams }),
      async (_req, res) => {
        res.json(await readOverview(deps.pool, brandContextOf(res).brandId))
      },
    ],
  })

  table.add({
    method: 'put',
    path: '/brands/:brandId/onboarding/intake',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary: 'Save the intake: the website, social links and competitors the research starts from',
    handlers: [
      validate({ params: brandParams, body: intakeSchema }),
      async (_req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof intakeSchema> }>(res)
        await saveIntake(deps.pool, deps, {
          brandId: brandContextOf(res).brandId,
          intake: body,
          actor: { userId: principalOf(res).userId },
        })
        res.json({ intake: body })
      },
    ],
  })

  if (deps.jobs) {
    const jobs = deps.jobs
    table.add({
      method: 'post',
      path: '/brands/:brandId/onboarding/research',
      access: { kind: 'permission', permission: 'onboard_brand' },
      summary: 'Start research: one job per source group, from the saved intake and the uploaded documents',
      handlers: [
        validate({ params: brandParams }),
        async (_req, res) => {
          res.json(
            await startResearch(deps.pool, jobs, {
              brandId: brandContextOf(res).brandId,
              actor: { userId: principalOf(res).userId },
            }),
          )
        },
      ],
    })
  }

  if (deps.jobs) {
    const jobs = deps.jobs
    table.add({
      method: 'post',
      path: '/brands/:brandId/onboarding/questionnaire',
      access: { kind: 'permission', permission: 'onboard_brand' },
      summary: 'Start the questionnaire: one job, from the draft profile, the gaps and the sources not read',
      handlers: [
        validate({ params: brandParams }),
        async (_req, res) => {
          res.json(
            await startQuestionnaire(deps.pool, jobs, {
              brandId: brandContextOf(res).brandId,
              actor: { userId: principalOf(res).userId },
            }),
          )
        },
      ],
    })
  }

  table.add({
    method: 'get',
    path: '/brands/:brandId/onboarding/questionnaire',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary: 'The questionnaire: its questions in order with the answers so far, and its job state',
    handlers: [
      validate({ params: brandParams }),
      async (_req, res) => {
        res.json(await readQuestionnaire(deps.pool, brandContextOf(res).brandId))
      },
    ],
  })

  table.add({
    method: 'put',
    path: '/brands/:brandId/onboarding/questionnaire/answers/:questionId',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary: 'Save an answer as typed; an empty value deletes it; refused once the questionnaire is finished',
    handlers: [
      validate({ params: questionParams, body: savedAnswerBody }),
      async (_req, res) => {
        const { params, body } = inputOf<{
          params: z.infer<typeof questionParams>
          body: z.infer<typeof savedAnswerBody>
        }>(res)
        res.json(
          await saveAnswer(deps.pool, {
            brandId: brandContextOf(res).brandId,
            questionId: params.questionId,
            value: body.value,
            actor: { userId: principalOf(res).userId },
          }),
        )
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/onboarding/questionnaire/finish',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary:
      'Finish the questionnaire: each answer becomes an owner statement, profile answers become profile items, and onboarding moves to facts and rules',
    handlers: [
      validate({ params: brandParams }),
      async (_req, res) => {
        res.json(
          await finishQuestionnaire(deps.pool, deps, {
            brandId: brandContextOf(res).brandId,
            actor: { userId: principalOf(res).userId },
          }),
        )
      },
    ],
  })

  if (deps.jobs) {
    const jobs = deps.jobs
    table.add({
      method: 'post',
      path: '/brands/:brandId/onboarding/facts-rules',
      access: { kind: 'permission', permission: 'onboard_brand' },
      summary:
        "Start facts and rules: one job, from the accepted profile, the finished questionnaire's answers and the brand's documents",
      handlers: [
        validate({ params: brandParams }),
        async (_req, res) => {
          res.json(
            await startFactsRules(deps.pool, jobs, {
              brandId: brandContextOf(res).brandId,
              actor: { userId: principalOf(res).userId },
            }),
          )
        },
      ],
    })
    table.add({
      method: 'post',
      path: '/brands/:brandId/onboarding/brief-choices',
      access: { kind: 'permission', permission: 'onboard_brand' },
      summary:
        'Start the brief choices: one job, from the profile, the facts and rules in force and the questionnaire answers',
      handlers: [
        validate({ params: brandParams }),
        async (_req, res) => {
          res.json(
            await startBriefChoices(deps.pool, jobs, {
              brandId: brandContextOf(res).brandId,
              actor: { userId: principalOf(res).userId },
            }),
          )
        },
      ],
    })
  }

  table.add({
    method: 'get',
    path: '/brands/:brandId/onboarding/brief-choices',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary: 'Brief choices: the job state and the current choices with their options and the owner’s pick',
    handlers: [
      validate({ params: brandParams }),
      async (_req, res) => {
        res.json(await readBriefChoices(deps.pool, brandContextOf(res).brandId))
      },
    ],
  })

  table.add({
    method: 'get',
    path: '/brands/:brandId/onboarding/facts-rules',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary:
      'Facts and rules: the job state, the fact and rule suggestions with their sources, and the facts and rules in force',
    handlers: [
      validate({ params: brandParams }),
      async (_req, res) => {
        res.json(await readFactsRules(deps.pool, brandContextOf(res).brandId))
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/onboarding/facts',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary:
      "Add your own fact: the owner's words are kept as an owner statement and confirmed as a verified fact",
    handlers: [
      validate({ params: brandParams, body: factBody }),
      async (_req, res) => {
        const { body } = inputOf<{ body: FactBody }>(res)
        res.json(
          await addOwnFact(deps.pool, deps, {
            brandId: brandContextOf(res).brandId,
            statement: body.statement,
            reviewDate: body.reviewDate,
            actor: { userId: principalOf(res).userId },
          }),
        )
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/onboarding/rules',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary:
      "Add your own safety rule: the owner's words are kept as an owner statement and confirmed as a rule",
    handlers: [
      validate({ params: brandParams, body: ruleBody }),
      async (_req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof ruleBody> }>(res)
        res.json(
          await addOwnRule(deps.pool, deps, {
            brandId: brandContextOf(res).brandId,
            kind: body.kind,
            text: body.text,
            why: body.why,
            actor: { userId: principalOf(res).userId },
          }),
        )
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/onboarding/facts/:factId/replace',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary:
      "Replace a fact in force with the owner's words: the old fact is kept, superseded by the new one",
    handlers: [
      validate({ params: factParams, body: factBody }),
      async (_req, res) => {
        const { params, body } = inputOf<{
          params: z.infer<typeof factParams>
          body: FactBody
        }>(res)
        res.json(
          await replaceFact(deps.pool, deps, {
            brandId: brandContextOf(res).brandId,
            factId: params.factId,
            statement: body.statement,
            reviewDate: body.reviewDate,
            actor: { userId: principalOf(res).userId },
          }),
        )
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/onboarding/facts/:factId/retire',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary: 'Retire a fact in force: it is kept, marked expired',
    handlers: [
      validate({ params: factParams }),
      async (_req, res) => {
        const { params } = inputOf<{ params: z.infer<typeof factParams> }>(res)
        res.json(
          await retireFact(deps.pool, deps, {
            brandId: brandContextOf(res).brandId,
            factId: params.factId,
            actor: { userId: principalOf(res).userId },
          }),
        )
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/onboarding/rules/:ruleId/turn-off',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary: 'Turn off a safety rule: it is kept, no longer active',
    handlers: [
      validate({ params: ruleParams }),
      async (_req, res) => {
        const { params } = inputOf<{ params: z.infer<typeof ruleParams> }>(res)
        res.json(
          await turnOffRule(deps.pool, deps, {
            brandId: brandContextOf(res).brandId,
            ruleId: params.ruleId,
            actor: { userId: principalOf(res).userId },
          }),
        )
      },
    ],
  })

  table.add({
    method: 'get',
    path: '/brands/:brandId/onboarding/agent-questions',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary:
      "The questions the brand's agent jobs asked: the open ones first, then the 20 most recently answered",
    handlers: [
      validate({ params: brandParams }),
      async (_req, res) => {
        res.json({ questions: await listAgentQuestions(deps.pool, brandContextOf(res).brandId) })
      },
    ],
  })

  if (deps.jobs) {
    const jobs = deps.jobs
    table.add({
      method: 'post',
      path: '/brands/:brandId/onboarding/agent-questions/:questionId/answer',
      access: { kind: 'permission', permission: 'onboard_brand' },
      summary:
        'Answer an agent question: the answer is kept as an owner statement and the job runs again with it; a question is answered once',
      handlers: [
        validate({ params: questionParams, body: answerBody }),
        async (_req, res) => {
          const { params, body } = inputOf<{
            params: z.infer<typeof questionParams>
            body: z.infer<typeof answerBody>
          }>(res)
          res.json(
            await answerAgentQuestion(jobs, {
              brandId: brandContextOf(res).brandId,
              questionId: params.questionId,
              answer: body.answer,
              actor: { userId: principalOf(res).userId },
            }),
          )
        },
      ],
    })
  }

  table.add({
    method: 'get',
    path: '/brands/:brandId/onboarding/suggestions',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary:
      'The suggestions of a brand, open and decided but not replaced, newest first, with their sources',
    handlers: [
      validate({ params: brandParams, query: listQuery }),
      async (_req, res) => {
        const { query } = inputOf<{ query: z.infer<typeof listQuery> }>(res)
        res.json({ suggestions: await listSuggestions(deps.pool, brandContextOf(res).brandId, query.step) })
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/onboarding/suggestions/accept-found',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary:
      'Accept every open draft profile suggestion that the agent found, leaving assumed and unknown ones',
    handlers: [
      validate({ params: brandParams, body: acceptBody }),
      async (_req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof acceptBody> }>(res)
        // Only the draft profile has a bulk accept. Facts and rules are confirmed one at a time, so none is
        // confirmed without the owner looking at it.
        if (body.step !== 'profile') {
          throw new AppError(
            400,
            'one_at_a_time',
            'Only the draft profile can be accepted all at once. Facts and rules are confirmed one at a time: confirm, edit or drop each one.',
          )
        }
        res.json(
          await acceptFound(deps.pool, deps, {
            brandId: brandContextOf(res).brandId,
            step: body.step,
            actor: { userId: principalOf(res).userId },
          }),
        )
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/onboarding/suggestions/:suggestionId/decision',
    access: { kind: 'permission', permission: 'onboard_brand' },
    summary:
      'Accept, edit or reject one suggestion; a decision is recorded with its reason and cannot be redone',
    handlers: [
      validate({ params: suggestionParams, body: decisionBody }),
      async (_req, res) => {
        const { params, body } = inputOf<{
          params: z.infer<typeof suggestionParams>
          body: z.infer<typeof decisionBody>
        }>(res)
        res.json(
          await decideSuggestion(deps.pool, deps, {
            brandId: brandContextOf(res).brandId,
            suggestionId: params.suggestionId,
            decision: body.decision,
            value: body.value,
            reason: body.reason,
            reviewDate: body.reviewDate,
            today: (deps.now ?? (() => new Date()))().toISOString().slice(0, 10),
            actor: { userId: principalOf(res).userId },
          }),
        )
      },
    ],
  })
}
