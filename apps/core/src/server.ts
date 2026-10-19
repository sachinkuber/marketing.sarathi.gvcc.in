import { createPool } from '@mkt/db'
import { openQueue } from '@mkt/queue'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Logger } from 'pino'
import type { Config } from './config.ts'
import { buildCore } from './core.ts'
import type { AuditSink, Mailer } from './ports.ts'
import { registerSummaryHandlers } from './agents/register.ts'
import type { ResultHandlers } from './jobs/results.ts'

export interface RunningServer {
  url: string
  stop(): Promise<void>
}

export async function startServer(
  config: Config,
  deps: { logger: Logger; mailer: Mailer; audit: AuditSink },
): Promise<RunningServer> {
  // The core's queue connection reads and writes jobs; it does not supervise (the workers do).
  const queue = await openQueue(config.queueDatabaseUrl)
  const results: ResultHandlers = new Map()
  const appPool = createPool(config.databaseUrl)
  const authPool = createPool(config.databaseUrl, { searchPath: 'auth' })
  // An idle client dropping (for example when the database restarts) emits 'error' on the pool;
  // with no listener that would crash the process. createPool leaves this to the caller.
  appPool.on('error', (error) => deps.logger.error({ err: error, pool: 'app' }, 'idle database client error'))
  authPool.on('error', (error) =>
    deps.logger.error({ err: error, pool: 'auth' }, 'idle database client error'),
  )
  registerSummaryHandlers(results, { audit: deps.audit, queue, backlogLimit: config.queueBacklogLimit })
  // trustProxy (AppDeps) is set at deployment (package 16) because the invite limiter keys on req.ip.
  const { app } = buildCore({
    config,
    logger: deps.logger,
    appPool,
    authPool,
    mailer: deps.mailer,
    audit: deps.audit,
    jobs: {
      pool: appPool,
      queue,
      audit: deps.audit,
      workerSecret: config.workerSecret,
      attemptTokenSecret: config.attemptTokenSecret,
      backlogLimit: config.queueBacklogLimit,
      now: () => new Date(),
      results,
    },
  })
  let server: Server
  try {
    // Express 5 calls this back with the error when listening fails (for example EADDRINUSE).
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(config.port, (error?: Error) =>
        error ? reject(error) : resolve(listening),
      )
    })
  } catch (error) {
    await Promise.allSettled([appPool.end(), authPool.end(), queue.stop()])
    throw error
  }
  const { port } = server.address() as AddressInfo
  // A second signal, or a second caller, waits for the same stop instead of closing twice.
  let stopping: Promise<void> | undefined
  const stop = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
    await appPool.end()
    await authPool.end()
    await queue.stop()
  }
  return {
    url: `http://127.0.0.1:${port}`,
    stop() {
      stopping ??= stop()
      return stopping
    },
  }
}
