import type { Pool } from '@mkt/db'
import type { BetterAuthOptions } from 'better-auth'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import type { Express, Router } from 'express'
import type { Logger } from 'pino'
import { createApi } from './api.ts'
import type { RouteTable } from './access/routes.ts'
import { createApp } from './app.ts'
import { AttemptLimiter } from './auth/limiter.ts'
import { LOCK_DURATION_MS, LOCK_MAX_FAILURES, LOCK_WINDOW_MS } from './auth/policy.ts'
import { createAuth, type Auth } from './auth/options.ts'
import type { Config } from './config.ts'
import { libraryLogger } from './logger.ts'
import { requestGuard } from './guard.ts'
import { UnconfiguredAlertChannel } from './adapters.ts'
import { errorName, systemClock, type AlertChannel, type Clock, type NotifyDeps } from './notify/ports.ts'
import type { AuditSink, Mailer } from './ports.ts'
import type { JobsDeps } from './jobs/service.ts'
import type { ExportStore } from './audit/store.ts'
import { runDailyDuties } from './triggers/duties.ts'
import type { FxSource } from './triggers/fx.ts'

export interface CoreDeps {
  config: Config
  logger: Logger
  appPool: Pool
  authPool: Pool
  mailer: Mailer
  audit: AuditSink
  // The work engine's dependencies. Unset: the service has no queue (tests that never create jobs).
  jobs?: JobsDeps
  // The second alert channel; unset (production until the real one exists) it is one that always fails.
  alertChannel?: AlertChannel
  // Unset: the system clock.
  clock?: Clock
  // What the daily duties need beyond the application pool; unset, POST /triggers/daily is not declared.
  daily?: {
    ownerViewPool: Pool
    auditWriterPool: Pool
    store: ExportStore | null
    fx: FxSource
    dutyBudgetMs?: number
  }
  limiter?: AttemptLimiter
  // The sign-in library's own log lines. Unset (production): sent through `logger`, see libraryLogger.
  authLogger?: BetterAuthOptions['logger']
  // A test seam: tests declare probe routes. Production leaves it unset.
  extraRoutes?: (table: RouteTable, context: { auth: Auth; pool: Pool }) => void
}

export function buildCore(deps: CoreDeps): {
  app: Express
  auth: Auth
  api: Router
  routes: RouteTable
} {
  const { config } = deps
  const limiter =
    deps.limiter ??
    new AttemptLimiter({ maxFailures: LOCK_MAX_FAILURES, windowMs: LOCK_WINDOW_MS, lockMs: LOCK_DURATION_MS })
  const auth = createAuth({
    pool: deps.authPool,
    secret: config.authSecret,
    baseURL: config.publicOrigin,
    mailer: deps.mailer,
    audit: deps.audit,
    limiter,
    logger: deps.authLogger ?? libraryLogger(deps.logger),
    // The error only: the message and the address stay out of the log.
    onMailFailure: (error) => deps.logger.error({ err: errorName(error) }, 'mail not sent'),
  })
  const guard = requestGuard({
    allowedOrigins: [config.publicOrigin],
    secret: config.authSecret,
    sessionIdFor: async (req) => {
      // Read only: a refresh here would extend the stored session and drop the renewed cookie, leaving
      // nothing for loadPrincipal to pass on.
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
        query: { disableRefresh: true },
      })
      return session?.session.id ?? null
    },
  })
  const notify: NotifyDeps = {
    pool: deps.appPool,
    mailer: deps.mailer,
    channel: deps.alertChannel ?? new UnconfiguredAlertChannel(),
    clock: deps.clock ?? systemClock,
    audit: deps.audit,
    logger: deps.logger,
    heartbeatExpected: config.n8nHeartbeatExpected,
  }
  const clock = deps.clock ?? systemClock
  const { daily } = deps
  const { router: api, table: routes } = createApi(
    {
      auth,
      pool: deps.appPool,
      secret: config.authSecret,
      limiter,
      audit: deps.audit,
      mailer: deps.mailer,
      origin: config.publicOrigin,
      onMailFailure: (error) => deps.logger.error({ err: errorName(error) }, 'mail not sent'),
      jobs: deps.jobs,
      notify,
      triggers: {
        secret: config.triggerSecret,
        pool: deps.appPool,
        now: () => clock.now(),
        logger: deps.logger,
      },
      daily: daily
        ? {
            now: () => clock.now(),
            run: (today) => runDailyDuties({ ...daily, appPool: deps.appPool, notify, clock }, today),
          }
        : undefined,
    },
    deps.extraRoutes,
  )
  const app = createApp({
    logger: deps.logger,
    ready: async () => {
      await deps.appPool.query('select 1')
    },
    guard,
    authHandler: toNodeHandler(auth),
    api,
  })
  return { app, auth, api, routes }
}
