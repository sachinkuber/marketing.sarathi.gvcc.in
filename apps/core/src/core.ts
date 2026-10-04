import type { Pool } from '@mkt/db'
import type { BetterAuthOptions } from 'better-auth'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import type { Express, Router } from 'express'
import type { Logger } from 'pino'
import { createApiRouter } from './api.ts'
import { createApp } from './app.ts'
import { AttemptLimiter } from './auth/limiter.ts'
import { LOCK_DURATION_MS, LOCK_MAX_FAILURES, LOCK_WINDOW_MS } from './auth/policy.ts'
import { createAuth, type Auth } from './auth/options.ts'
import type { Config } from './config.ts'
import { libraryLogger } from './logger.ts'
import { requestGuard } from './guard.ts'
import type { AuditSink, Mailer } from './ports.ts'

export interface CoreDeps {
  config: Config
  logger: Logger
  appPool: Pool
  authPool: Pool
  mailer: Mailer
  audit: AuditSink
  limiter?: AttemptLimiter
  // The sign-in library's own log lines. Unset (production): sent through `logger`, see libraryLogger.
  authLogger?: BetterAuthOptions['logger']
}

export function buildCore(deps: CoreDeps): { app: Express; auth: Auth; api: Router } {
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
    onMailFailure: (error) => deps.logger.error({ err: error }, 'mail not sent'),
  })
  const guard = requestGuard({
    allowedOrigins: [config.publicOrigin],
    secret: config.authSecret,
    sessionIdFor: async (req) => {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
      return session?.session.id ?? null
    },
  })
  const api = createApiRouter({
    auth,
    pool: deps.appPool,
    secret: config.authSecret,
    limiter,
    audit: deps.audit,
  })
  const app = createApp({
    logger: deps.logger,
    ready: async () => {
      await deps.appPool.query('select 1')
    },
    guard,
    authHandler: toNodeHandler(auth),
    api,
  })
  return { app, auth, api }
}
