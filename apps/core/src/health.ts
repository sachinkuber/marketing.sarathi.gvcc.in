import { Router } from 'express'
import type { Logger } from 'pino'

interface HealthDeps {
  logger: Logger
  ready: () => Promise<void>
  now: () => Date
}

export function healthRouter(deps: HealthDeps): Router {
  const router = Router()
  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' })
  })
  router.get('/ready', async (_req, res) => {
    try {
      await deps.ready()
      res.json({ status: 'ok' })
    } catch (err) {
      deps.logger.warn({ err }, 'readiness check failed')
      res.status(503).json({ status: 'unavailable' })
    }
  })
  router.get('/heartbeat', (_req, res) => {
    res.json({ status: 'ok', at: deps.now().toISOString() })
  })
  return router
}
