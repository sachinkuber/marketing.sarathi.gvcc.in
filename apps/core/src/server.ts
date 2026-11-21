import { createPool } from '@mkt/db'
import { openQueue } from '@mkt/queue'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Logger } from 'pino'
import { createS3Client, S3ExportStore } from './audit/s3-store.ts'
import type { Config } from './config.ts'
import { buildCore } from './core.ts'
import type { AuditSink, Mailer } from './ports.ts'
import {
  registerBriefChoicesHandlers,
  registerFactsRulesHandlers,
  registerQuestionnaireHandlers,
  registerResearchHandlers,
  registerStrategistHandlers,
  registerSummaryHandlers,
} from './agents/register.ts'
import type { ChangeHandlers } from './content/change-handlers.ts'
import type { ResultHandlers } from './jobs/results.ts'
import type { SettledHooks } from './jobs/service.ts'
import { registerBriefChangeHandler } from './onboarding/brief.ts'
import { ecbFxSource } from './triggers/fx.ts'

export interface RunningServer {
  url: string
  stop(): Promise<void>
}

// Ruling R42: the proxy in front (Caddy) keeps an idle connection to the core for up to 2 minutes, but Node closes
// one after 5 s by default, so a request sent on a connection the core is closing fails with a 502. The core keeps
// idle connections for 125 s, longer than the proxy, with the header limit just above that. Both stay under Node's
// 300 s request timeout.
export function keepIdleConnections(server: Server): void {
  server.keepAliveTimeout = 125_000
  server.headersTimeout = 126_000
}

export async function startServer(
  config: Config,
  deps: { logger: Logger; mailer: Mailer; audit: AuditSink },
): Promise<RunningServer> {
  // The core's queue connection reads and writes jobs; it does not supervise (the workers do).
  const queue = await openQueue(config.queueDatabaseUrl)
  const results: ResultHandlers = new Map()
  const settled: SettledHooks = new Map()
  const appPool = createPool(config.databaseUrl)
  const authPool = createPool(config.databaseUrl, { searchPath: 'auth' })
  // The owner-view role reads the audit log and records the exchange rate; the audit-writer role records the
  // export. The daily duties use both; the owner-view pool also serves the audit screens and the run detail
  // (they are declared only when it is passed, so OWNER_VIEW_DATABASE_URL is required in the configuration).
  const ownerViewPool = createPool(config.ownerViewDatabaseUrl)
  const auditWriterPool = createPool(config.auditDatabaseUrl)
  // An idle client dropping (for example when the database restarts) emits 'error' on the pool;
  // with no listener that would crash the process. createPool leaves this to the caller.
  appPool.on('error', (error) => deps.logger.error({ err: error, pool: 'app' }, 'idle database client error'))
  authPool.on('error', (error) =>
    deps.logger.error({ err: error, pool: 'auth' }, 'idle database client error'),
  )
  for (const [name, pool] of [
    ['owner_view', ownerViewPool],
    ['audit_writer', auditWriterPool],
  ] as const) {
    pool.on('error', (error) => deps.logger.error({ err: error, pool: name }, 'idle database client error'))
  }
  registerSummaryHandlers(results, { audit: deps.audit, queue, backlogLimit: config.queueBacklogLimit })
  registerResearchHandlers(results, settled, {
    audit: deps.audit,
    queue,
    backlogLimit: config.queueBacklogLimit,
  })
  registerQuestionnaireHandlers(results)
  registerFactsRulesHandlers(results, { audit: deps.audit })
  registerBriefChoicesHandlers(results, { audit: deps.audit })
  registerStrategistHandlers(results, { audit: deps.audit })
  // Ask for changes on a strategy brief starts the strategist again (app flow 5.6).
  const changeHandlers: ChangeHandlers = new Map()
  registerBriefChangeHandler(changeHandlers, {
    audit: deps.audit,
    queue,
    backlogLimit: config.queueBacklogLimit,
    now: () => new Date(),
  })
  // config.trustProxy tells the app how many proxies sit in front, so req.ip (the invite limiter's key) is the client's.
  const { app } = buildCore({
    config,
    logger: deps.logger,
    appPool,
    authPool,
    // Without the AUDIT_STORE_* settings the export reports not_configured and the verify runs its chain-only check.
    daily: {
      ownerViewPool,
      auditWriterPool,
      store: config.auditStore
        ? new S3ExportStore({
            client: createS3Client(config.auditStore),
            bucket: config.auditStore.bucket,
            retentionDays: config.auditStore.retentionDays,
            objectLock: config.auditStore.objectLock,
          })
        : null,
      fx: ecbFxSource(),
    },
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
      settled,
    },
    changeHandlers,
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
    await Promise.allSettled([
      appPool.end(),
      authPool.end(),
      ownerViewPool.end(),
      auditWriterPool.end(),
      queue.stop(),
    ])
    throw error
  }
  keepIdleConnections(server)
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
    await ownerViewPool.end()
    await auditWriterPool.end()
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
