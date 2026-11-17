import { hostname } from 'node:os'
import { JOB_CLASSES, type JobClass } from '@mkt/queue'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CORE_URL: z.url(),
  WORKER_SECRET: z.string().min(32),
  QUEUE_DATABASE_URL: z.url(),
  WORKER_ID: z.string().min(1).optional(),
  JOB_CLASSES: z.string().optional(),
  PROCESSES_PER_CLASS: z.coerce.number().int().min(1).default(1),
  MODEL_BACKEND: z.enum(['anthropic', 'standin']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  SUPERVISE_INTERVAL_SECONDS: z.coerce.number().int().positive().optional(),
  // Error reporting; unset means none. A credential: never logged or put in an error.
  SENTRY_DSN: z.url().optional(),
  // The build or version label attached to error reports; unset means 'dev'.
  RELEASE: z.string().min(1).max(200).optional(),
})

export interface WorkerConfig {
  nodeEnv: 'development' | 'test' | 'production'
  coreUrl: string
  workerSecret: string
  queueUrl: string
  workerId: string
  classes: JobClass[]
  processesPerClass: number
  modelBackend: 'anthropic' | 'standin'
  anthropicApiKey: string | null
  reconcileIntervalSeconds: number
  superviseIntervalSeconds: number | undefined
  sentryDsn?: string
  release?: string
}

export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  // An empty SENTRY_DSN is the same as unset.
  const picked: Record<string, string> = {}
  for (const key of Object.keys(schema.shape)) {
    const value = env[key]
    if (value !== undefined && !(key === 'SENTRY_DSN' && value === '')) picked[key] = value
  }
  const parsed = schema.safeParse(picked)
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(', ')
    throw new Error(`Invalid configuration: ${names}`)
  }
  const c = parsed.data
  if (c.NODE_ENV === 'production') {
    // Every value, whatever the variable: a template placeholder never reaches a running service. Names only.
    const refused = Object.entries(picked)
      .filter(([, v]) => v.includes('CHANGE_ME'))
      .map(([key]) => key)
    if (refused.length > 0) throw new Error(`Invalid configuration: ${refused.join(', ')}`)
  }
  const classes = (
    c.JOB_CLASSES ? c.JOB_CLASSES.split(',').map((s) => s.trim()) : [...JOB_CLASSES]
  ) as JobClass[]
  if (classes.some((k) => !JOB_CLASSES.includes(k))) throw new Error('Invalid configuration: JOB_CLASSES')
  if (c.MODEL_BACKEND === 'standin' && c.NODE_ENV !== 'test') {
    throw new Error('Invalid configuration: MODEL_BACKEND')
  }
  if (c.MODEL_BACKEND === 'anthropic' && !c.ANTHROPIC_API_KEY) {
    throw new Error('Invalid configuration: ANTHROPIC_API_KEY')
  }
  return {
    nodeEnv: c.NODE_ENV,
    coreUrl: c.CORE_URL,
    workerSecret: c.WORKER_SECRET,
    queueUrl: c.QUEUE_DATABASE_URL,
    workerId: c.WORKER_ID ?? `${hostname()}-${process.pid}`,
    classes,
    processesPerClass: c.PROCESSES_PER_CLASS,
    modelBackend: c.MODEL_BACKEND,
    anthropicApiKey: c.ANTHROPIC_API_KEY ?? null,
    reconcileIntervalSeconds: c.RECONCILE_INTERVAL_SECONDS,
    superviseIntervalSeconds: c.SUPERVISE_INTERVAL_SECONDS,
    sentryDsn: c.SENTRY_DSN,
    release: c.RELEASE,
  }
}
