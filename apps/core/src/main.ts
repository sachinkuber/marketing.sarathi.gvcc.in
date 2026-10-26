import { createPool } from '@mkt/db'
import { DbAudit } from './audit/db-audit.ts'
import { loadConfig } from './config.ts'
import { createLogger } from './logger.ts'
import { mailerFromConfig } from './notify/smtp.ts'
import { startServer } from './server.ts'

const config = loadConfig(process.env)
const logger = createLogger(config.logLevel)
const auditPool = createPool(config.auditDatabaseUrl)
auditPool.on('error', (error) => logger.error({ err: error, pool: 'audit' }, 'idle database client error'))
const server = await startServer(config, {
  logger,
  mailer: mailerFromConfig(config),
  audit: new DbAudit(auditPool),
})
logger.info({ url: server.url }, 'core service started')

let stopping = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    // A repeated signal (a second Ctrl-C, or SIGTERM after SIGINT) does not start a second stop.
    if (stopping) return
    stopping = true
    logger.info({ signal }, 'stopping')
    server.stop().then(
      () =>
        auditPool.end().then(
          () => process.exit(0),
          () => process.exit(1),
        ),
      () => process.exit(1),
    )
  })
}
