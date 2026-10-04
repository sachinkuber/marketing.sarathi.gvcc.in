import type { Pool } from '@mkt/db'
import { Router } from 'express'
import { enrolmentGate, loadPrincipal, principalOf } from './auth/session.ts'
import type { AttemptLimiter } from './auth/limiter.ts'
import type { Auth } from './auth/options.ts'
import { csrfTokenFor } from './guard.ts'
import type { AuditSink } from './ports.ts'
import { inviteRoutes } from './routes/invites.ts'

export interface ApiDeps {
  auth: Auth
  pool: Pool
  secret: string
  limiter: AttemptLimiter
  audit: AuditSink
}

export function createApiRouter(deps: ApiDeps): Router {
  const api = Router()

  api.get('/session', loadPrincipal(deps.auth, deps.pool), (_req, res) => {
    const principal = principalOf(res)
    res.json({
      user: { id: principal.userId, email: principal.email, name: principal.name },
      twoFactorEnabled: principal.twoFactorEnabled,
      needsSecondFactor: principal.needsSecondFactor,
      enrolmentRequired: principal.needsSecondFactor && !principal.twoFactorEnabled,
      platformOwner: principal.isPlatformOwner,
      memberships: principal.memberships,
      csrfToken: csrfTokenFor(deps.secret, principal.sessionId),
    })
  })

  api.use(
    '/invites',
    inviteRoutes({ auth: deps.auth, pool: deps.pool, limiter: deps.limiter, audit: deps.audit }),
  )
  // Public routes (no session) are added above this line.

  // Everything below needs a session, and for most roles a completed enrolment.
  api.use(loadPrincipal(deps.auth, deps.pool), enrolmentGate)
  return api
}
