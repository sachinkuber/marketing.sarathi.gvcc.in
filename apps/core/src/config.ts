import { z } from 'zod'

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

// An address, or `Name <address>` (the name may be quoted). No control characters, so no header can be injected.
const ADDRESS = '[^\\s<>@",;]+@[^\\s<>@",;]+\\.[^\\s<>@",;]+'
const MAIL_FROM_PATTERN = new RegExp(`^(?:${ADDRESS}|(?:"[^"\\r\\n]+"|[^<>"@,;\\r\\n]+?)\\s*<${ADDRESS}>)$`)

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url(),
  AUDIT_DATABASE_URL: z.url(),
  QUEUE_DATABASE_URL: z.url(),
  OWNER_VIEW_DATABASE_URL: z.url(),
  AUTH_SECRET: z.string().min(32),
  WORKER_SECRET: z.string().min(32),
  ATTEMPT_TOKEN_SECRET: z.string().min(32),
  TRIGGER_SECRET: z.string().min(32),
  QUEUE_BACKLOG_LIMIT: z.coerce.number().int().positive().default(2000),
  PUBLIC_ORIGIN: z.url(),
  // No missing-heartbeat alert until the daily n8n workflow is live.
  N8N_HEARTBEAT_EXPECTED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Mail: both or neither. SMTP_URL carries credentials, so it is never logged or put in an error.
  SMTP_URL: z.url().optional(),
  MAIL_FROM: z.string().regex(MAIL_FROM_PATTERN).optional(),
  LOG_LEVEL: z.enum(LEVELS).default('info'),
})

export interface Config {
  nodeEnv: 'development' | 'test' | 'production'
  port: number
  databaseUrl: string
  auditDatabaseUrl: string
  queueDatabaseUrl: string
  ownerViewDatabaseUrl: string
  authSecret: string
  workerSecret: string
  attemptTokenSecret: string
  triggerSecret: string
  queueBacklogLimit: number
  publicOrigin: string
  n8nHeartbeatExpected: boolean
  smtpUrl?: string
  mailFrom?: string
  logLevel: (typeof LEVELS)[number]
}

// Reads only the variables the service knows. A failure names the variables and never prints a value.
export function loadConfig(env: Record<string, string | undefined>): Config {
  const picked: Record<string, string> = {}
  for (const key of Object.keys(schema.shape)) {
    const value = env[key]
    // An empty value is the same as unset, so a blank line in a deployment file turns mail off.
    if (value !== undefined && !((key === 'SMTP_URL' || key === 'MAIL_FROM') && value === '')) {
      picked[key] = value
    }
  }
  const parsed = schema.safeParse(picked)
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))]
    throw new Error(`Invalid configuration: ${names.join(', ')}`)
  }
  const value = parsed.data
  // Four secrets, four purposes: one leaking must not open the others.
  const secrets = [value.AUTH_SECRET, value.WORKER_SECRET, value.ATTEMPT_TOKEN_SECRET, value.TRIGGER_SECRET]
  if (new Set(secrets).size !== secrets.length) {
    throw new Error('Invalid configuration: secrets must differ')
  }
  if (value.SMTP_URL && !value.MAIL_FROM) throw new Error('Invalid configuration: MAIL_FROM')
  if (value.MAIL_FROM && !value.SMTP_URL) throw new Error('Invalid configuration: SMTP_URL')
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    auditDatabaseUrl: value.AUDIT_DATABASE_URL,
    queueDatabaseUrl: value.QUEUE_DATABASE_URL,
    ownerViewDatabaseUrl: value.OWNER_VIEW_DATABASE_URL,
    authSecret: value.AUTH_SECRET,
    workerSecret: value.WORKER_SECRET,
    attemptTokenSecret: value.ATTEMPT_TOKEN_SECRET,
    triggerSecret: value.TRIGGER_SECRET,
    queueBacklogLimit: value.QUEUE_BACKLOG_LIMIT,
    publicOrigin: new URL(value.PUBLIC_ORIGIN).origin,
    n8nHeartbeatExpected: value.N8N_HEARTBEAT_EXPECTED,
    smtpUrl: value.SMTP_URL,
    mailFrom: value.MAIL_FROM,
    logLevel: value.LOG_LEVEL,
  }
}
