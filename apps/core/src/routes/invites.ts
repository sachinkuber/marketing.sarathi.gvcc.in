import type { Pool } from '@mkt/db'
import { z } from 'zod'
import type { RouteTable } from '../access/routes.ts'
import { acceptInvite, lookupInvite } from '../auth/invites.ts'
import { attemptKey, type AttemptLimiter } from '../auth/limiter.ts'
import type { Auth } from '../auth/options.ts'
import { PASSWORD_MAX, PASSWORD_MIN } from '../auth/policy.ts'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'
import { inputOf, validate } from '../validate.ts'

const token = z.string().min(20).max(200)
const lookupBody = z.strictObject({ token })
const acceptBody = z.strictObject({
  token,
  name: z.string().trim().min(1).max(100),
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
})

// Public: the person has no session yet. The origin check in the request guard still applies.
export function registerInviteRoutes(
  table: RouteTable,
  deps: {
    auth: Auth
    pool: Pool
    limiter: AttemptLimiter
    audit: AuditSink
  },
): void {
  table.add({
    method: 'post',
    path: '/invites/lookup',
    access: { kind: 'public' },
    summary: 'Show an invited person their email, role and brand',
    handlers: [
      validate({ body: lookupBody }),
      async (req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof lookupBody> }>(res)
        const key = attemptKey('/invites/accept', req.ip ?? 'unknown')
        if (deps.limiter.check(key) > 0) {
          await deps.audit.record({
            action: 'auth.locked_out',
            actor: null,
            outcome: 'failure',
            detail: { path: '/invites/lookup' },
          })
          throw new AppError(429, 'too_many_attempts', 'Too many attempts. Try again later.')
        }
        let found: Awaited<ReturnType<typeof lookupInvite>>
        try {
          found = await lookupInvite(deps.pool, body.token)
        } catch (error) {
          deps.limiter.fail(key)
          await deps.audit.record({ action: 'auth.invite_lookup', actor: null, outcome: 'failure' })
          throw error
        }
        res.json(found)
      },
    ],
  })
  table.add({
    method: 'post',
    path: '/invites/accept',
    access: { kind: 'public' },
    summary: 'Accept an invite: make the account and the membership',
    handlers: [
      validate({ body: acceptBody }),
      async (req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof acceptBody> }>(res)
        const key = attemptKey('/invites/accept', req.ip ?? 'unknown')
        if (deps.limiter.check(key) > 0) {
          await deps.audit.record({
            action: 'auth.locked_out',
            actor: null,
            outcome: 'failure',
            detail: { path: '/invites/accept' },
          })
          throw new AppError(429, 'too_many_attempts', 'Too many attempts. Try again later.')
        }
        let accepted: Awaited<ReturnType<typeof acceptInvite>>
        try {
          accepted = await acceptInvite(deps.auth, deps.pool, body)
        } catch (error) {
          deps.limiter.fail(key)
          await deps.audit.record({ action: 'auth.invite_accepted', actor: null, outcome: 'failure' })
          throw error
        }
        // The account exists now: a failure to write the audit entry is not a failed attempt.
        deps.limiter.succeed(key)
        await deps.audit.record({
          action: 'auth.invite_accepted',
          actor: accepted.userId,
          brandId: accepted.brandId,
          outcome: 'success',
        })
        res.status(201).json({ userId: accepted.userId })
      },
    ],
  })
}
