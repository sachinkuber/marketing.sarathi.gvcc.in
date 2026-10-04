import express, { type Express, type RequestHandler, type Router } from 'express'
import helmet from 'helmet'
import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import { pinoHttp } from 'pino-http'
import { errorHandler, notFoundHandler } from './errors.ts'
import { healthRouter } from './health.ts'

export interface AppDeps {
  logger: Logger
  ready: () => Promise<void>
  now?: () => Date
  // Number of proxies in front of the service. Set to 1 behind the server's proxy at deployment.
  trustProxy?: number
  guard?: RequestHandler
  authHandler?: RequestHandler
  api?: Router
}

// The query string and any reset token in the path never reach the log.
export function redactUrl(url: string | undefined): string {
  const path = (url ?? '').split('?')[0] ?? ''
  return path.replace(/\/reset-password\/[^/]+/, '/reset-password/[token]')
}

export function createApp(deps: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', deps.trustProxy ?? 0)
  app.use(helmet())
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (_req, res) => {
        const id = randomUUID()
        res.setHeader('x-request-id', id)
        return id
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: redactUrl(req.url) }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  )
  app.use(
    '/health',
    healthRouter({ logger: deps.logger, ready: deps.ready, now: deps.now ?? (() => new Date()) }),
  )
  if (deps.guard) app.use('/api', deps.guard)
  // The auth library reads the raw request body, so it is mounted before the JSON parser.
  if (deps.authHandler) app.all('/api/auth/*splat', deps.authHandler)
  app.use(express.json({ limit: '100kb', strict: true }))
  if (deps.api) app.use('/api/v1', deps.api)
  app.use(notFoundHandler)
  app.use(errorHandler(deps.logger))
  return app
}
