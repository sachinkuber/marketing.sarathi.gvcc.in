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
