import { agentFilesHash, initErrorTracking } from '@mkt/shared'
import { openQueue, type JobClass } from '@mkt/queue'
import { anthropicModel } from './anthropic.ts'
import { loadWorkerConfig, type WorkerConfig } from './config.ts'
import { httpCoreClient, type CoreClient } from './core-client.ts'
import type { ModelClient } from './model.ts'
import { DEFAULT_MAX_WAIT_SECONDS, startMaintenance } from './maintenance.ts'
import { runJob, type HandlerEntry } from './runner.ts'
import { checkHandler } from './agents/check.ts'
import {
  RESEARCH_DIR,
  RESEARCH_MERGE_DIR,
  researchGroupHandler,
  researchMergeHandler,
} from './agents/research.ts'
import { FACTS_RULES_DIR, factsRulesHandler } from './agents/facts-rules.ts'
import { BRIEF_CHOICES_DIR, briefChoicesHandler } from './agents/brief-choices.ts'
import { STRATEGIST_DIR, strategistHandler } from './agents/strategist.ts'
import { QUESTIONNAIRE_DIR, questionnaireHandler } from './agents/questionnaire.ts'
import { SUMMARY_DIR, summaryHandler } from './agents/summary.ts'

export interface WorkerOptions {
  core: CoreClient
  model: ModelClient
  handlers: Record<string, HandlerEntry>
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
    workerId: options.workerId,
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

// The production registry. The summary handler runs on agents/summary/; the placeholder check loads no agent
// files and makes no model call (ruling R3), so it names no agent.
export function defaultHandlers(): Record<string, HandlerEntry> {
  return {
    'summary.v1': { handler: summaryHandler, agent: 'summary', filesHash: agentFilesHash(SUMMARY_DIR) },
    'research_group.v1': {
      handler: researchGroupHandler,
      agent: 'research',
      filesHash: agentFilesHash(RESEARCH_DIR),
    },
    'research.v1': {
      handler: researchMergeHandler,
      agent: 'research_merge',
      filesHash: agentFilesHash(RESEARCH_MERGE_DIR),
    },
    'questionnaire.v1': {
      handler: questionnaireHandler,
      agent: 'questionnaire',
      filesHash: agentFilesHash(QUESTIONNAIRE_DIR),
    },
    'facts_rules.v1': {
      handler: factsRulesHandler,
      agent: 'facts_rules',
      filesHash: agentFilesHash(FACTS_RULES_DIR),
    },
    'brief_choices.v1': {
      handler: briefChoicesHandler,
      agent: 'brief_choices',
      filesHash: agentFilesHash(BRIEF_CHOICES_DIR),
    },
    'strategy_brief.v1': {
      handler: strategistHandler,
      agent: 'strategist',
      filesHash: agentFilesHash(STRATEGIST_DIR),
    },
    'placeholder_check.v1': { handler: checkHandler, agent: null, filesHash: null },
  }
}

// What the stand-in answers when the worker runs it as a process (the compose stack test, the load test): a
// result the summary contract accepts, so runs finish instead of being retried and dead-lettered.
const STANDIN_SUMMARY = JSON.stringify({
  summary: 'A stand-in summary of the brief.',
  keywords: ['stand-in', 'summary', 'brief'],
})

// The stand-in is accepted by the configuration only under NODE_ENV=test, and is loaded only here, so the
// production module graph does not contain it.
export async function chooseModel(config: WorkerConfig): Promise<ModelClient> {
  if (config.modelBackend === 'standin') {
    return (await import('./standin.ts')).standInModel({
      logFile: process.env.MODEL_LOG ?? '/dev/null',
      replyFor: () => STANDIN_SUMMARY,
      delayMs: config.standinDelayMs,
    })
  }
  return anthropicModel(config.anthropicApiKey!)
}

// The production entry, guarded so importing this module (from a test) starts nothing and reads no
// environment.
if (import.meta.main) {
  const config = loadWorkerConfig(process.env)
  // First thing once the DSN is known: the config load is the only earlier step, and it never reports a value.
  initErrorTracking({ dsn: config.sentryDsn, service: 'worker', release: config.release ?? 'dev' })
  const handlers = defaultHandlers()
  const model = await chooseModel(config)
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
