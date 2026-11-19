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
  // The stand-in's answer time in whole milliseconds (the load test, spec 17 test 41). Checked and used only
  // when MODEL_BACKEND=standin; with the real model it is not read.
  STANDIN_DELAY_MS: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  // The maintenance tick is the heartbeat, and the core reports the worker stale after 900 s without one:
  // at most 450 s leaves room for one missed tick.
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().max(450).default(300),
  SUPERVISE_INTERVAL_SECONDS: z.coerce.number().int().positive().optional(),
  // Error reporting; unset means none. A credential: never logged or put in an error.
  SENTRY_DSN: z.url().optional(),
  // The build or version label attached to error reports; unset means 'dev'.
  RELEASE: z.string().min(1).max(200).optional(),
})

const STANDIN_DELAY_MAX_MS = 60_000

export interface WorkerConfig {
  nodeEnv: 'development' | 'test' | 'production'
  coreUrl: string
  workerSecret: string
  queueUrl: string
  workerId: string
  classes: JobClass[]
  processesPerClass: number
  modelBackend: 'anthropic' | 'standin'
  // 0 unless MODEL_BACKEND=standin and STANDIN_DELAY_MS is set.
  standinDelayMs: number
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
  let standinDelayMs = 0
  if (c.MODEL_BACKEND === 'standin' && c.STANDIN_DELAY_MS !== undefined) {
    // Digits only, so '', ' 20', '1.5', '2e3' and '0x10' are refused rather than coerced.
    if (!/^\d{1,5}$/.test(c.STANDIN_DELAY_MS) || Number(c.STANDIN_DELAY_MS) > STANDIN_DELAY_MAX_MS) {
      throw new Error('Invalid configuration: STANDIN_DELAY_MS')
    }
    standinDelayMs = Number(c.STANDIN_DELAY_MS)
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
    standinDelayMs,
    anthropicApiKey: c.ANTHROPIC_API_KEY ?? null,
    reconcileIntervalSeconds: c.RECONCILE_INTERVAL_SECONDS,
    superviseIntervalSeconds: c.SUPERVISE_INTERVAL_SECONDS,
    sentryDsn: c.SENTRY_DSN,
    release: c.RELEASE,
  }
}
