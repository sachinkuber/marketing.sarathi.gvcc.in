import { z } from 'zod'

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url(),
  AUDIT_DATABASE_URL: z.url(),
  QUEUE_DATABASE_URL: z.url(),
  AUTH_SECRET: z.string().min(32),
  WORKER_SECRET: z.string().min(32),
  ATTEMPT_TOKEN_SECRET: z.string().min(32),
  TRIGGER_SECRET: z.string().min(32),
  QUEUE_BACKLOG_LIMIT: z.coerce.number().int().positive().default(2000),
  PUBLIC_ORIGIN: z.url(),
  LOG_LEVEL: z.enum(LEVELS).default('info'),
})

export interface Config {
  nodeEnv: 'development' | 'test' | 'production'
  port: number
  databaseUrl: string
  auditDatabaseUrl: string
  queueDatabaseUrl: string
  authSecret: string
  workerSecret: string
  attemptTokenSecret: string
  triggerSecret: string
  queueBacklogLimit: number
  publicOrigin: string
  logLevel: (typeof LEVELS)[number]
}

// Reads only the variables the service knows. A failure names the variables and never prints a value.
export function loadConfig(env: Record<string, string | undefined>): Config {
  const picked: Record<string, string> = {}
  for (const key of Object.keys(schema.shape)) {
    const value = env[key]
    if (value !== undefined) picked[key] = value
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
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    auditDatabaseUrl: value.AUDIT_DATABASE_URL,
    queueDatabaseUrl: value.QUEUE_DATABASE_URL,
    authSecret: value.AUTH_SECRET,
    workerSecret: value.WORKER_SECRET,
    attemptTokenSecret: value.ATTEMPT_TOKEN_SECRET,
    triggerSecret: value.TRIGGER_SECRET,
    queueBacklogLimit: value.QUEUE_BACKLOG_LIMIT,
    publicOrigin: new URL(value.PUBLIC_ORIGIN).origin,
    logLevel: value.LOG_LEVEL,
  }
}
