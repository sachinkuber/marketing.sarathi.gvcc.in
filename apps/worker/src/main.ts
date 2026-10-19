import { openQueue, type JobClass } from '@mkt/queue'
import { anthropicModel } from './anthropic.ts'
import { loadWorkerConfig } from './config.ts'
import { httpCoreClient, type CoreClient } from './core-client.ts'
import type { ModelClient } from './model.ts'
import { DEFAULT_MAX_WAIT_SECONDS, startMaintenance } from './maintenance.ts'
import { runJob, type JobHandler } from './runner.ts'
import { checkHandler } from './agents/check.ts'
import { summaryHandler } from './agents/summary.ts'

export interface WorkerOptions {
  core: CoreClient
  model: ModelClient
  handlers: Record<string, JobHandler>
  queueUrl: string
  workerId: string
  classes: JobClass[]
  processesPerClass: number
  superviseIntervalSeconds?: number
  // How often the model-call sweep and the watchdog read run (default 300).
  reconcileIntervalSeconds?: number
  maxWaitSeconds?: Record<JobClass, number>
  log?: (line: Record<string, unknown>) => void
}

// How long running jobs may take to finish after a stop signal.
const STOP_TIMEOUT_SECONDS = 30

export interface StopOptions {
  graceful?: boolean
  timeoutSeconds?: number
}

export async function startWorker(
  options: WorkerOptions,
): Promise<{ stop(options?: StopOptions): Promise<void> }> {
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)))
  const queue = await openQueue(options.queueUrl, {
    supervise: true,
    onError: (error) => log({ event: 'queue_error', error: error.message }),
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
  // The library gives up on a job after its last retry and copies it to the class's dead-letter queue; the
  // core is told, so the job and its run are marked and the job is listed.
  for (const jobClass of options.classes) {
    await queue.onDead(jobClass, (jobId) => options.core.jobDead(jobId))
  }
  const maintenance = startMaintenance({
    core: options.core,
    queue,
    intervalSeconds: options.reconcileIntervalSeconds ?? 300,
    maxWaitSeconds: options.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS,
    log,
  })
  return {
    stop: async (stopOptions) => {
      maintenance.stop()
      await queue.stop(stopOptions)
    },
  }
}

// The production entry, guarded so importing this module (from a test) starts nothing and reads no
// environment.
if (import.meta.main) {
  const config = loadWorkerConfig(process.env)
  const handlers: Record<string, JobHandler> = {
    'summary.v1': summaryHandler,
    'placeholder_check.v1': checkHandler,
  }
  // The stand-in is accepted by the configuration only under NODE_ENV=test, and is loaded only here, so the
  // production module graph does not contain it.
  const model =
    config.modelBackend === 'standin'
      ? (await import('./standin.ts')).standInModel({ logFile: process.env.MODEL_LOG ?? '/dev/null' })
      : anthropicModel(config.anthropicApiKey!)
  const worker = await startWorker({
    core: httpCoreClient(config.coreUrl, config.workerSecret),
    model,
    handlers,
    queueUrl: config.queueUrl,
    workerId: config.workerId,
    classes: config.classes,
    processesPerClass: config.processesPerClass,
    reconcileIntervalSeconds: config.reconcileIntervalSeconds,
    ...(config.superviseIntervalSeconds ? { superviseIntervalSeconds: config.superviseIntervalSeconds } : {}),
  })
  // A stop signal takes no new job and gives running jobs time to finish (their attempts are then complete,
  // not recovered by the heartbeat). A second signal while stopping is ignored.
  let stopping = false
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) return
      stopping = true
      worker.stop({ graceful: true, timeoutSeconds: STOP_TIMEOUT_SECONDS }).then(
        () => process.exit(0),
        (error: unknown) => {
          console.error('The worker did not stop cleanly.', error)
          process.exit(1)
        },
      )
    })
  }
}
