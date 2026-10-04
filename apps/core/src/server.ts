import { createPool } from '@mkt/db'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Logger } from 'pino'
import type { Config } from './config.ts'
import { buildCore } from './core.ts'
import type { AuditSink, Mailer } from './ports.ts'

export interface RunningServer {
  url: string
  stop(): Promise<void>
}

export async function startServer(
  config: Config,
  deps: { logger: Logger; mailer: Mailer; audit: AuditSink },
): Promise<RunningServer> {
  const appPool = createPool(config.databaseUrl)
  const authPool = createPool(config.databaseUrl, { searchPath: 'auth' })
  // An idle client dropping (for example when the database restarts) emits 'error' on the pool;
  // with no listener that would crash the process. createPool leaves this to the caller.
  appPool.on('error', (error) => deps.logger.error({ err: error, pool: 'app' }, 'idle database client error'))
  authPool.on('error', (error) =>
    deps.logger.error({ err: error, pool: 'auth' }, 'idle database client error'),
  )
  // trustProxy (AppDeps) is set at deployment (package 16) because the invite limiter keys on req.ip.
  const { app } = buildCore({
    config,
    logger: deps.logger,
    appPool,
    authPool,
    mailer: deps.mailer,
    audit: deps.audit,
  })
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(config.port, () => resolve(listening))
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
      await appPool.end()
      await authPool.end()
    },
  }
}
