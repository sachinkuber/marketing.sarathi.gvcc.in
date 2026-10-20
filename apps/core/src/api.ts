import type { Pool } from '@mkt/db'
import type { Router } from 'express'
import { RouteTable } from './access/routes.ts'
import { principalOf } from './auth/session.ts'
import type { AttemptLimiter } from './auth/limiter.ts'
import type { Auth } from './auth/options.ts'
import { csrfTokenFor } from './guard.ts'
import type { AuditSink, Mailer } from './ports.ts'
import { registerBrandRoutes } from './routes/brands.ts'
import { registerAlertRoutes } from './routes/alerts.ts'
import { registerOverdueRoutes } from './routes/overdue.ts'
import type { NotifyDeps } from './notify/ports.ts'
import { registerApprovalRoutes } from './routes/approvals.ts'
import { registerApprovalSettingsRoutes } from './routes/approval-settings.ts'
import { registerKillSwitchRoutes } from './routes/killswitch.ts'
import { releaseHeldJobs } from './killswitch/release.ts'
import { registerContentRoutes } from './routes/content.ts'
import { registerInviteRoutes } from './routes/invites.ts'
import { registerAgentReadRoutes, registerAgentRoutes } from './routes/agents.ts'
import { registerJobRoutes } from './routes/jobs.ts'
import { registerAuditRoutes, type OwnerView } from './routes/audit.ts'
import { registerHomeRoutes } from './routes/home.ts'
import { registerStatusRoutes } from './routes/status.ts'
import { registerUserRoutes } from './routes/users.ts'
import { registerWorkerRoutes } from './routes/worker.ts'
import type { JobsDeps } from './jobs/service.ts'
import type { TriggerDeps } from './access/trigger-auth.ts'
import { registerTriggerRoutes, type DailyTrigger } from './routes/triggers.ts'

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
  // The work engine; unset, no worker route is declared.
  jobs?: JobsDeps
  // Notification and alert delivery; the reconciliation timer route runs it.
  notify?: NotifyDeps
  // Signed calls from n8n; unset, no trigger route is declared.
  triggers?: TriggerDeps
  // The daily duties behind POST /triggers/daily; unset, that route is not declared.
  daily?: DailyTrigger
  // The owner-view pool and the export store: the audit screens and the run detail read the log through them.
  // Unset, the routes that read the audit log are not declared.
  ownerView?: OwnerView
  // The service's clock, for "this month" and the time of a verify. Unset: the system clock.
  now?: () => Date
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
    auth: deps.auth,
    pool: deps.pool,
    mailer: deps.mailer,
    audit: deps.audit,
    origin: deps.origin,
    onMailFailure: deps.onMailFailure,
  })

  registerContentRoutes(table, { pool: deps.pool, audit: deps.audit })
  registerApprovalRoutes(table, { pool: deps.pool, audit: deps.audit })
  registerApprovalSettingsRoutes(table, { pool: deps.pool, audit: deps.audit })
  registerKillSwitchRoutes(table, {
    auth: deps.auth,
    pool: deps.pool,
    audit: deps.audit,
    afterRelease: deps.jobs ? releaseHeldJobs(deps.jobs) : undefined,
  })
  registerAlertRoutes(table, { pool: deps.pool, audit: deps.audit })
  registerOverdueRoutes(table, { pool: deps.pool, audit: deps.audit })
  const now = deps.now ?? (() => new Date())
  registerStatusRoutes(table, { pool: deps.pool })
  registerHomeRoutes(table, { pool: deps.pool, now })
  registerAgentReadRoutes(table, {
    pool: deps.pool,
    now,
    audit: deps.ownerView ? { ownerView: deps.ownerView, sink: deps.audit } : undefined,
  })
  if (deps.ownerView) registerAuditRoutes(table, { ownerView: deps.ownerView, audit: deps.audit, now })

  if (deps.jobs) {
    registerWorkerRoutes(table, deps.jobs, deps.notify)
    registerJobRoutes(table, deps.jobs)
    registerAgentRoutes(table, deps.jobs)
  }

  if (deps.triggers) registerTriggerRoutes(table, { audit: deps.audit, daily: deps.daily })

  extra?.(table, { auth: deps.auth, pool: deps.pool })
  return {
    router: table.build({ auth: deps.auth, pool: deps.pool, jobs: deps.jobs, triggers: deps.triggers }),
    table,
  }
}
