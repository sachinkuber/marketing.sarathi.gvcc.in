import { openQueue, type JobClass } from '@mkt/queue'
import { anthropicModel } from './anthropic.ts'
import { loadWorkerConfig } from './config.ts'
import { httpCoreClient, type CoreClient } from './core-client.ts'
import type { ModelClient } from './model.ts'
import { runJob, type JobHandler } from './runner.ts'
import { standInModel } from './standin.ts'

export interface WorkerOptions {
  core: CoreClient
  model: ModelClient
  handlers: Record<string, JobHandler>
  queueUrl: string
  workerId: string
  classes: JobClass[]
  processesPerClass: number
  superviseIntervalSeconds?: number
}

export async function startWorker(options: WorkerOptions): Promise<{ stop(): Promise<void> }> {
  const queue = await openQueue(options.queueUrl, {
    supervise: true,
    ...(options.superviseIntervalSeconds
      ? { superviseIntervalSeconds: options.superviseIntervalSeconds }
      : {}),
  })
  const deps = {
    core: options.core,
    model: options.model,
    handlers: options.handlers,
    workerId: options.workerId,
  }
  for (const jobClass of options.classes) {
    await queue.work(jobClass, { processes: options.processesPerClass }, (job) => runJob(deps, job))
  }
  return { stop: () => queue.stop() }
}

// The production entry, guarded so importing this module (from a test) starts nothing and reads no
// environment.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadWorkerConfig(process.env)
  // Phase 1 registers no production handler: the trivial agent (package 13) adds its own.
  const handlers: Record<string, JobHandler> = {}
  // The stand-in is accepted by the configuration only under NODE_ENV=test.
  const model =
    config.modelBackend === 'standin'
      ? standInModel({ logFile: process.env.MODEL_LOG ?? '/dev/null' })
      : anthropicModel(config.anthropicApiKey!)
  const worker = await startWorker({
    core: httpCoreClient(config.coreUrl, config.workerSecret),
    model,
    handlers,
    queueUrl: config.queueUrl,
    workerId: config.workerId,
    classes: config.classes,
    processesPerClass: config.processesPerClass,
    ...(config.superviseIntervalSeconds ? { superviseIntervalSeconds: config.superviseIntervalSeconds } : {}),
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void worker.stop().then(() => process.exit(0)))
  }
}
