import type { BetterAuthOptions } from 'better-auth'
import { pino, type DestinationStream, type LevelWithSilent, type Logger } from 'pino'

export const REDACTED_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'code',
  'backupCode',
  'backupCodes',
  'secret',
  'totpURI',
  'authorization',
  'cookie',
]

const paths = [
  ...REDACTED_KEYS,
  ...REDACTED_KEYS.map((key) => `*.${key}`),
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
]

export function createLogger(level: LevelWithSilent, destination?: DestinationStream): Logger {
  return pino({ level, redact: { paths, censor: '[Redacted]' } }, destination)
}

// The sign-in library's own log lines, sent through the service logger instead of the console. Only the
// message is kept, plus the name and message of any error passed with it: the other arguments (objects,
// error details and stacks) can hold an address or a stored value, so they are dropped.
// `level` stays unset on purpose: set to warn, error or debug, the library's router also writes the message
// of every refused request through its own console logger.
export function libraryLogger(logger: Logger): NonNullable<BetterAuthOptions['logger']> {
  return {
    log: (level, message, ...args) => {
      const errors = args
        .filter((arg): arg is Error => arg instanceof Error)
        .map((error) => ({ type: error.name, message: error.message }))
      logger[level]({ library: 'better-auth', ...(errors.length > 0 ? { errors } : {}) }, message)
    },
  }
}
