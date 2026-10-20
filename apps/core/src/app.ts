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
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const CHECKPOINT_PATH = new RegExp(`^/api/v1/worker/jobs/${UUID}/model-calls/${UUID}/checkpoint$`)

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
  // One request skips the 100 kB parser: a worker's checkpoint, whose route reads up to 1 MB itself after the
  // worker credential and attempt token are checked. The match is exact: POST, case-sensitive, uuid segments,
  // no trailing segment, so no other path or method gets the larger limit and nothing large is read before auth.
  const smallJson = express.json({ limit: '100kb', strict: true })
  // Signed triggers are read as raw bytes (the signature covers them exactly as received) and capped at 16 kB.
  app.use('/api/v1/triggers', express.raw({ type: '*/*', limit: '16kb' }))
  app.use((req, res, next) => {
    if (req.originalUrl.startsWith('/api/v1/triggers/')) return next()
    if (req.method === 'POST' && CHECKPOINT_PATH.test(req.originalUrl.split('?')[0] ?? '')) return next()
    return smallJson(req, res, next)
  })
  if (deps.api) app.use('/api/v1', deps.api)
  app.use(notFoundHandler)
  app.use(errorHandler(deps.logger))
  return app
}
