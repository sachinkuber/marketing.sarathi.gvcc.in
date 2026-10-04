import type { Pool } from '@mkt/db'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import type { Express, Router } from 'express'
import type { Logger } from 'pino'
import { createApiRouter } from './api.ts'
import { createApp } from './app.ts'
import { createAuth, type Auth } from './auth/options.ts'
import type { Config } from './config.ts'
import { requestGuard } from './guard.ts'
import type { AuditSink, Mailer } from './ports.ts'

export interface CoreDeps {
  config: Config
  logger: Logger
  appPool: Pool
  authPool: Pool
  mailer: Mailer
  audit: AuditSink
}

export function buildCore(deps: CoreDeps): { app: Express; auth: Auth; api: Router } {
  const { config } = deps
  const auth = createAuth({
    pool: deps.authPool,
    secret: config.authSecret,
    baseURL: config.publicOrigin,
    mailer: deps.mailer,
    audit: deps.audit,
  })
  const guard = requestGuard({
    allowedOrigins: [config.publicOrigin],
    secret: config.authSecret,
    sessionIdFor: async (req) => {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
      return session?.session.id ?? null
    },
  })
  const api = createApiRouter({ auth, pool: deps.appPool, secret: config.authSecret })
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
