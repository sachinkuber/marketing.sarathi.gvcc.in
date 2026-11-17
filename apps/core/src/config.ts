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
  // Proxies in front of the service (0 to 3). Required in production: the limiter keys on the client address.
  TRUST_PROXY: z
    .string()
    .regex(/^[0-3]$/)
    .optional(),
  // Error reporting; unset means none. The DSN is a credential, so it is never logged or put in an error.
  SENTRY_DSN: z.url().optional(),
  // The build or version label attached to error reports; unset means 'dev'.
  RELEASE: z.string().min(1).max(200).optional(),
  // Write-once audit copies in an S3-compatible bucket: URL, BUCKET, KEY_ID and SECRET together or not at all.
  // The key and secret are credentials, so they are never logged or put in an error.
  AUDIT_STORE_URL: z.url().optional(),
  AUDIT_STORE_BUCKET: z.string().min(3).max(63).optional(),
  AUDIT_STORE_KEY_ID: z.string().min(1).optional(),
  AUDIT_STORE_SECRET: z.string().min(1).optional(),
  AUDIT_STORE_RETENTION_DAYS: z.coerce.number().int().min(1).max(36500).default(400),
  // true when the bucket has Object Lock (the objects are then sent with a compliance-mode retention date); false
  // for a store that holds retention in a bucket rule (R2).
  AUDIT_STORE_OBJECT_LOCK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

// Variables where an empty value means unset, so a blank line in a deployment file turns the feature off.
const BLANK_IS_UNSET = new Set([
  'SMTP_URL',
  'MAIL_FROM',
  'SENTRY_DSN',
  'AUDIT_STORE_URL',
  'AUDIT_STORE_BUCKET',
  'AUDIT_STORE_KEY_ID',
  'AUDIT_STORE_SECRET',
])
const AUDIT_STORE_GROUP = [
  'AUDIT_STORE_URL',
  'AUDIT_STORE_BUCKET',
  'AUDIT_STORE_KEY_ID',
  'AUDIT_STORE_SECRET',
] as const

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
  trustProxy: number
  sentryDsn?: string
  release?: string
  auditStore?: {
    url: string
    bucket: string
    keyId: string
    secret: string
    retentionDays: number
    objectLock: boolean
  }
}

// Reads only the variables the service knows. A failure names the variables and never prints a value.
export function loadConfig(env: Record<string, string | undefined>): Config {
  const picked: Record<string, string> = {}
  for (const key of Object.keys(schema.shape)) {
    const value = env[key]
    // An empty value is the same as unset, so a blank line in a deployment file turns mail off.
    if (value !== undefined && !(BLANK_IS_UNSET.has(key) && value === '')) {
      picked[key] = value
    }
  }
  const parsed = schema.safeParse(picked)
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))]
    throw new Error(`Invalid configuration: ${names.join(', ')}`)
  }
  const value = parsed.data
  if (value.NODE_ENV === 'production') {
    // Every value, whatever the variable: a template placeholder never reaches a running service. Names only.
    const refused = Object.entries(picked)
      .filter(([, v]) => v.includes('CHANGE_ME'))
      .map(([key]) => key)
    if (!value.PUBLIC_ORIGIN.startsWith('https://') && !refused.includes('PUBLIC_ORIGIN')) {
      refused.push('PUBLIC_ORIGIN')
    }
    if (value.TRUST_PROXY === undefined) refused.push('TRUST_PROXY')
    if (refused.length > 0) throw new Error(`Invalid configuration: ${refused.join(', ')}`)
  }
  // Four secrets, four purposes: one leaking must not open the others.
  const secrets = [value.AUTH_SECRET, value.WORKER_SECRET, value.ATTEMPT_TOKEN_SECRET, value.TRIGGER_SECRET]
  if (new Set(secrets).size !== secrets.length) {
    throw new Error('Invalid configuration: secrets must differ')
  }
  if (value.SMTP_URL && !value.MAIL_FROM) throw new Error('Invalid configuration: MAIL_FROM')
  if (value.MAIL_FROM && !value.SMTP_URL) throw new Error('Invalid configuration: SMTP_URL')
  // The audit store: all four or none. Names the missing variables and prints no value.
  const storeMissing = AUDIT_STORE_GROUP.filter((key) => value[key] === undefined)
  const storeSet = storeMissing.length < AUDIT_STORE_GROUP.length
  if (storeMissing.length > 0 && storeSet) {
    throw new Error(`Invalid configuration: ${storeMissing.join(', ')}`)
  }
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
    trustProxy: Number(value.TRUST_PROXY ?? '0'),
    sentryDsn: value.SENTRY_DSN,
    release: value.RELEASE,
    auditStore:
      value.AUDIT_STORE_URL &&
      value.AUDIT_STORE_BUCKET &&
      value.AUDIT_STORE_KEY_ID &&
      value.AUDIT_STORE_SECRET
        ? {
            url: value.AUDIT_STORE_URL,
            bucket: value.AUDIT_STORE_BUCKET,
            keyId: value.AUDIT_STORE_KEY_ID,
            secret: value.AUDIT_STORE_SECRET,
            retentionDays: value.AUDIT_STORE_RETENTION_DAYS,
            objectLock: value.AUDIT_STORE_OBJECT_LOCK,
          }
        : undefined,
  }
}
