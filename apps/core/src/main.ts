import { LogAudit, UnconfiguredMailer } from './adapters.ts'
import { loadConfig } from './config.ts'
import { createLogger } from './logger.ts'
import { startServer } from './server.ts'

const config = loadConfig(process.env)
const logger = createLogger(config.logLevel)
const server = await startServer(config, {
  logger,
  mailer: new UnconfiguredMailer(),
  audit: new LogAudit(logger),
})
logger.info({ url: server.url }, 'core service started')

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'stopping')
    server.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
}
