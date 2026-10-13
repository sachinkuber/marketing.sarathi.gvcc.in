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
}

export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(', ')
    throw new Error(`Invalid configuration: ${names}`)
  }
  const c = parsed.data
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
  }
}
