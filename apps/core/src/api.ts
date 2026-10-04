import type { Pool } from '@mkt/db'
import type { Router } from 'express'
import { RouteTable } from './access/routes.ts'
import { principalOf } from './auth/session.ts'
import type { AttemptLimiter } from './auth/limiter.ts'
import type { Auth } from './auth/options.ts'
import { csrfTokenFor } from './guard.ts'
import type { AuditSink, Mailer } from './ports.ts'
import { registerBrandRoutes } from './routes/brands.ts'
import { registerInviteRoutes } from './routes/invites.ts'
import { registerUserRoutes } from './routes/users.ts'

export interface ApiDeps {
  auth: Auth
  pool: Pool
  secret: string
  limiter: AttemptLimiter
  audit: AuditSink
  mailer: Mailer
  // The configured public origin: invite links never use anything from the request.
  origin: string
  onMailFailure?: (error: unknown) => void
}

export interface ApiContext {
  auth: Auth
  pool: Pool
}

// Every route of the service is declared here, through the table, and nowhere else.
export function createApi(
  deps: ApiDeps,
  extra?: (table: RouteTable, context: ApiContext) => void,
): { router: Router; table: RouteTable } {
  const table = new RouteTable()

  table.add({
    method: 'get',
    path: '/session',
    access: { kind: 'signed_in' },
    summary: 'The signed-in person, their memberships and the request token',
    handlers: [
      (_req, res) => {
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
      },
    ],
  })

  registerInviteRoutes(table, {
    auth: deps.auth,
    pool: deps.pool,
    limiter: deps.limiter,
    audit: deps.audit,
  })
  registerBrandRoutes(table, { pool: deps.pool })
  registerUserRoutes(table, {
    pool: deps.pool,
    mailer: deps.mailer,
    audit: deps.audit,
    origin: deps.origin,
    onMailFailure: deps.onMailFailure,
  })

  extra?.(table, { auth: deps.auth, pool: deps.pool })
  return { router: table.build({ auth: deps.auth, pool: deps.pool }), table }
}
