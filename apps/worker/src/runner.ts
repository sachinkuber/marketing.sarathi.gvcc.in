import { createHash } from 'node:crypto'
import type { JobClass } from '@mkt/queue'
import { CoreError, type CoreClient } from './core-client.ts'
import { isDefiniteRefusal, type ModelClient, type ModelRequest } from './model.ts'

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
  // `allowHeld`: stop only for a cancel (used before the result is posted, when a held job still posts so
  // the core keeps the paid-for result).
  checkStop(options?: { allowHeld?: boolean }): Promise<void>
}
export type JobHandler = (ctx: JobContext) => Promise<{ type: string; result: unknown }>

export interface RunnerDeps {
  core: CoreClient
  model: ModelClient
  handlers: Record<string, JobHandler>
  workerId: string
  // The pause before the first retry of a checkpoint post; it doubles each time. Tests shorten it.
  checkpointRetryDelayMs?: number
}

const CHECKPOINT_ATTEMPTS = 5

// A paid reply is worth keeping: a checkpoint post that failed in transit is repeated (the core treats a
// repeat as harmless). Only a network error or a 5xx is repeated; a 4xx (403 attempt_refused: this attempt
// was superseded, 400: the request is wrong) will not change by asking again and is passed on at once.
function isTransient(error: unknown): boolean {
  if (error instanceof CoreError) return error.status >= 500
  return true
}

// The hash covers everything that decides the provider's answer, in a fixed key order, so the same
// step with the same request is recognised after a crash (spec 9.5).
function requestHash(request: ModelRequest): string {
  const ordered = {
    model: request.model,
    system: request.system || null,
    messages: request.messages.map((m) => [m.role, m.content]),
    maxTokens: request.maxTokens,
    effort: request.effort ?? null,
  }
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

export async function runJob(
  deps: RunnerDeps,
  job: { id: string; jobClass: JobClass; queueId?: string },
): Promise<void> {
  const started = await deps.core.startAttempt(job.id, deps.workerId, job.queueId)
  // Finished already (the core accepted the result and the worker died before completing the queue row).
  if (started.finished) return
  // Held (by a kill switch or a hold), or a queue copy a release has replaced: no attempt was made; stop and
  // post nothing.
  if ('outcome' in started) return
  const handler = deps.handlers[started.expectedResultType]
  if (!handler) throw new Error(`no handler for ${started.expectedResultType}`)

  const ctx: JobContext = {
    jobId: job.id,
    jobClass: job.jobClass,
    input: started.input,
    async checkStop(options) {
      const control = await deps.core.control(job.id, started.token)
      if (control.cancelRequested) throw new JobStopped('cancelled')
      if (control.held && !options?.allowHeld) throw new JobStopped('held')
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

      // An empty system prompt and none are the same request, and are sent the same way.
      const sent: ModelRequest = { ...request }
      if (!sent.system) delete sent.system

      let reply
      try {
        reply = await deps.model.send(sent)
      } catch (error) {
        // Only a request the provider definitely refused is marked failed. A connection error or timeout
        // may have been answered and charged, so the call stays 'started' for reconciliation (spec 9.5).
        if (isDefiniteRefusal(error)) {
          try {
            await deps.core.failCall(
              job.id,
              started.token,
              registered.callId,
              error instanceof Error ? error.message : String(error),
            )
          } catch {
            // The provider's error is the one that matters; the call stays 'started' and is reconciled.
          }
        }
        throw error
      }
      const output = { text: reply.text }
      const body = {
        step,
        output,
        model: request.model,
        providerMessageId: reply.messageId,
        providerRequestId: reply.requestId,
        usage: reply.usage,
      }
      let delay = deps.checkpointRetryDelayMs ?? 250
      for (let attempt = 1; ; attempt += 1) {
        try {
          await deps.core.checkpoint(job.id, started.token, registered.callId, body)
          break
        } catch (error) {
          if (attempt >= CHECKPOINT_ATTEMPTS || !isTransient(error)) throw error
          await new Promise((resolve) => setTimeout(resolve, delay))
          delay *= 2
        }
      }
      return output
    },
  }

  try {
    const outcome = await handler(ctx)
    // A cancel that arrived while the last step ran is seen here, before the result is posted. A hold is not:
    // the result is posted anyway and the core stores it as held (spec 9.4), so the work is not lost.
    await ctx.checkStop({ allowHeld: true })
    await deps.core.postResult(job.id, started.token, outcome)
  } catch (error) {
    // A cancelled or held job ends here without a retry: the core already knows.
    if (error instanceof JobStopped) return
    // The cancel can also arrive between the check and the post: the core refuses the result with 409.
    if (error instanceof CoreError && error.status === 409 && error.code === 'job_cancelled') return
    throw error
  }
}
