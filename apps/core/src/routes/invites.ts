import type { Pool } from '@mkt/db'
import { Router } from 'express'
import { z } from 'zod'
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
export function inviteRoutes(deps: {
  auth: Auth
  pool: Pool
  limiter: AttemptLimiter
  audit: AuditSink
}): Router {
  const router = Router()
  router.post('/lookup', validate({ body: lookupBody }), async (req, res) => {
    const { body } = inputOf<{ body: z.infer<typeof lookupBody> }>(res)
    const key = attemptKey('/invites/accept', req.ip ?? 'unknown')
    if (deps.limiter.check(key) > 0)
      throw new AppError(429, 'too_many_attempts', 'Too many attempts. Try again later.')
    try {
      res.json(await lookupInvite(deps.pool, body.token))
    } catch (error) {
      deps.limiter.fail(key)
      throw error
    }
  })
  router.post('/accept', validate({ body: acceptBody }), async (req, res) => {
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
    try {
      const accepted = await acceptInvite(deps.auth, deps.pool, body)
      deps.limiter.succeed(key)
      await deps.audit.record({
        action: 'auth.invite_accepted',
        actor: accepted.userId,
        brandId: accepted.brandId,
        outcome: 'success',
      })
      res.status(201).json({ userId: accepted.userId })
    } catch (error) {
      deps.limiter.fail(key)
      await deps.audit.record({ action: 'auth.invite_accepted', actor: null, outcome: 'failure' })
      throw error
    }
  })
  return router
}
