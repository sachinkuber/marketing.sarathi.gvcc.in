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

let stopping = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    // A repeated signal (a second Ctrl-C, or SIGTERM after SIGINT) does not start a second stop.
    if (stopping) return
    stopping = true
    logger.info({ signal }, 'stopping')
    server.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
}
