import type { Pool } from '@mkt/db'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { principalOf } from '../auth/session.ts'
import type { AuditSink } from '../ports.ts'
import { acceptFound, decideSuggestion, listSuggestions } from '../onboarding/suggestions.ts'
import { inputOf, validate } from '../validate.ts'
import type { JobsDeps } from '../jobs/service.ts'
import { intakeSchema, readOverview, saveIntake, startResearch } from '../onboarding/research.ts'

export interface OnboardingRouteDeps {
  pool: Pool
  audit: AuditSink
  // Present only with the work engine; starting research needs it.
  jobs?: JobsDeps
}

const STEPS = ['profile', 'question', 'fact', 'rule', 'choice'] as const
const brandParams = z.strictObject({ brandId: z.uuid() })
const suggestionParams = z.strictObject({ brandId: z.uuid(), suggestionId: z.uuid() })
const listQuery = z.strictObject({ step: z.enum(STEPS).optional() })
const acceptBody = z.strictObject({ step: z.enum(STEPS) })

const MAX_VALUE = 4000
const decisionBody = z
  .strictObject({
    decision: z.enum(['accepted', 'edited', 'rejected']),
    value: z.unknown().optional(),
    reason: z.string().max(2000).optional(),
  })
  .superRefine((b, ctx) => {
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
      'Accept every open suggestion of one step that the agent found, leaving assumed and unknown ones',
    handlers: [
      validate({ params: brandParams, body: acceptBody }),
      async (_req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof acceptBody> }>(res)
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
            actor: { userId: principalOf(res).userId },
          }),
        )
      },
    ],
  })
}
