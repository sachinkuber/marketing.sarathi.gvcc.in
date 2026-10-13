import { createHash } from 'node:crypto'
import type { JobClass } from '@mkt/queue'
import type { CoreClient } from './core-client.ts'
import type { ModelClient, ModelRequest } from './model.ts'

export class JobStopped extends Error {
  readonly why: 'cancelled' | 'held'
  constructor(why: 'cancelled' | 'held') {
    super(`job ${why}`)
    this.why = why
  }
}

export interface JobContext {
  jobId: string
  jobClass: JobClass
  input: unknown
  // One model call as a step: checkpointed, never sent again once saved, stopped by cancel or hold.
  modelStep(step: string, request: ModelRequest): Promise<{ text: string }>
  // Called between steps: throws JobStopped when the job was cancelled or held.
  checkStop(): Promise<void>
}
export type JobHandler = (ctx: JobContext) => Promise<{ type: string; result: unknown }>

export interface RunnerDeps {
  core: CoreClient
  model: ModelClient
  handlers: Record<string, JobHandler>
  workerId: string
}

// The hash covers everything that decides the provider's answer, in a fixed key order, so the same
// step with the same request is recognised after a crash (spec 9.5).
function requestHash(request: ModelRequest): string {
  const ordered = {
    model: request.model,
    system: request.system ?? null,
    messages: request.messages,
    maxTokens: request.maxTokens,
    effort: request.effort ?? null,
  }
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

export async function runJob(deps: RunnerDeps, job: { id: string; jobClass: JobClass }): Promise<void> {
  const started = await deps.core.startAttempt(job.id, deps.workerId)
  // Finished already (the core accepted the result and the worker died before completing the queue row).
  if (started.finished) return
  const handler = deps.handlers[started.expectedResultType]
  if (!handler) throw new Error(`no handler for ${started.expectedResultType}`)

  const ctx: JobContext = {
    jobId: job.id,
    jobClass: job.jobClass,
    input: started.input,
    async checkStop() {
      const control = await deps.core.control(job.id, started.token)
      if (control.cancelRequested) throw new JobStopped('cancelled')
      if (control.held) throw new JobStopped('held')
    },
    async modelStep(step, request) {
      const registered = await deps.core.registerModelCall(job.id, started.token, {
        step,
        requestHash: requestHash(request),
        model: request.model,
      })
      if (registered.outcome === 'use_checkpoint') return registered.output as { text: string }
      if (registered.outcome === 'cancelled' || registered.outcome === 'held') {
        throw new JobStopped(registered.outcome)
      }

      let reply
      try {
        reply = await deps.model.send(request)
      } catch (error) {
        await deps.core.failCall(
          job.id,
          started.token,
          registered.callId,
          error instanceof Error ? error.message : String(error),
        )
        throw error
      }
      const output = { text: reply.text }
      await deps.core.checkpoint(job.id, started.token, registered.callId, {
        step,
        output,
        model: request.model,
        providerMessageId: reply.messageId,
        providerRequestId: reply.requestId,
        usage: reply.usage,
      })
      return output
    },
  }

  try {
    const outcome = await handler(ctx)
    await deps.core.postResult(job.id, started.token, outcome)
  } catch (error) {
    // A cancelled or held job ends here without a retry: the core already knows.
    if (error instanceof JobStopped) return
    throw error
  }
}
