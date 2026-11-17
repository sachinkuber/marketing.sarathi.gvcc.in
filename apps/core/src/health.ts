import { Router } from 'express'
import type { Logger } from 'pino'
import { errorName } from './notify/ports.ts'

interface HealthDeps {
  logger: Logger
  ready: () => Promise<void>
  now: () => Date
  // When the worker last stamped the heartbeat, or null if it never has.
  workerLastSeen: () => Promise<Date | null>
  workerStaleAfterMs?: number
}

// The worker's timer runs every 5 minutes by default; three missed beats is stale.
export const WORKER_STALE_AFTER_MS = 15 * 60_000

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
  router.get('/worker', async (_req, res) => {
    try {
      const seen = await deps.workerLastSeen()
      if (seen === null) {
        res.status(503).json({ status: 'never' })
        return
      }
      const age = deps.now().getTime() - seen.getTime()
      const lastSeen = seen.toISOString()
      if (age > (deps.workerStaleAfterMs ?? WORKER_STALE_AFTER_MS)) {
        res.status(503).json({ status: 'stale', lastSeen })
        return
      }
      res.json({ status: 'ok', lastSeen })
    } catch (err) {
      deps.logger.warn({ err: errorName(err) }, 'worker heartbeat check failed')
      res.status(503).json({ status: 'unavailable' })
    }
  })
  return router
}
