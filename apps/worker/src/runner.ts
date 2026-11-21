import { createHash } from 'node:crypto'
import type { JobClass } from '@mkt/queue'
import {
  CoreError,
  type AgentAnswer,
  type AgentQuestion,
  type CoreClient,
  type JobDocument,
} from './core-client.ts'
import {
  isDefiniteRefusal,
  ModelStopped,
  type ModelClient,
  type ModelRequest,
  type ModelUsage,
} from './model.ts'

export class JobStopped extends Error {
  readonly why: 'cancelled' | 'held'
  constructor(why: 'cancelled' | 'held') {
    super(`job ${why}`)
    this.why = why
  }
}

// The job asked the owner a question (spec 9): the core has stored it and ended the attempt, and the job waits for
// the answer, which starts it again. Like a stop, it ends the job here without a result and without a retry.
export class JobWaiting extends Error {
  readonly questionId: string
  constructor(questionId: string) {
    super('job waiting for an answer')
    this.questionId = questionId
  }
}

// What a model step gives back. A step replayed from a checkpoint carries zero token usage (it was not paid
// for again); `content` is [] for a step saved before content was kept. The runner always
// sets both; they are optional so a test double of a step need not.
export interface ModelStepResult {
  text: string
  // Absent only on a step saved before the stop reason was kept.
  stopReason?: string | null
  content?: unknown[]
  usage?: Required<ModelUsage>
}

// Request timeout by job class: a request must end before the queue expires the job. Production jobs run
// long research steps and expire later.
export const TIMEOUT_MS_BY_CLASS: Partial<Record<JobClass, number>> = {
  interactive: 240_000,
  production: 900_000,
}

// The most a checkpoint body may be: the core reads it with an 8 MB parser (8 * 1024 * 1024 bytes). A larger
// body would be refused after it was sent, so it is refused here instead (StepTooLarge).
export const CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024

// A reply too large to save as its step (a tool step carries the search results and fetched pages). The paid
// call is costed with a cost-only checkpoint, as a stop is, and the attempt then fails with this error.
export class StepTooLarge extends Error {
  constructor(step: string, bytes: number) {
    super(
      `The reply to step ${step} is ${(bytes / 1_048_576).toFixed(1)} MB with its search results and fetched ` +
        'pages, too large to save (a step saves at most 8 MB). The call was costed; nothing was saved.',
    )
    this.name = 'StepTooLarge'
  }
}

const NO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  serverToolSearches: 0,
  serverToolFetches: 0,
}

// Search and fetch counts of a replayed step, read from its saved content (counts are not saved apart).
function toolCounts(content: unknown[]): { serverToolSearches: number; serverToolFetches: number } {
  let serverToolSearches = 0
  let serverToolFetches = 0
  for (const block of content) {
    const b = block as { type?: unknown; name?: unknown }
    if (b?.type !== 'server_tool_use') continue
    if (b.name === 'web_search') serverToolSearches += 1
    if (b.name === 'web_fetch') serverToolFetches += 1
  }
  return { serverToolSearches, serverToolFetches }
}

function serverCounts(usage: ModelUsage): { serverToolSearches: number; serverToolFetches: number } {
  return {
    serverToolSearches: usage.serverToolSearches ?? 0,
    serverToolFetches: usage.serverToolFetches ?? 0,
  }
}

function replayed(output: unknown): ModelStepResult {
  // A tool step is saved as a JSON string; a step without tools as an object.
  const saved = (typeof output === 'string' ? JSON.parse(output) : output) as {
    text: string
    stopReason?: string | null
    content?: unknown[]
    serverToolSearches?: number
    serverToolFetches?: number
  }
  const content = saved.content ?? []
  // The provider's own counts were saved with the step; counting blocks is only for a step saved without them
  // (a search that errored is in the blocks but not billed, and the counts decide the next request's budget).
  const counted = toolCounts(content)
  return {
    text: saved.text,
    ...(saved.stopReason === undefined ? {} : { stopReason: saved.stopReason }),
    content,
    usage: {
      ...NO_USAGE,
      serverToolSearches: saved.serverToolSearches ?? counted.serverToolSearches,
      serverToolFetches: saved.serverToolFetches ?? counted.serverToolFetches,
    },
  }
}

// A step is a tool step when its request has tools or carries raw content blocks (a continuation).
function isToolStep(request: ModelRequest): boolean {
  return (request.tools?.length ?? 0) > 0 || request.messages.some((m) => typeof m.content !== 'string')
}

export interface JobContext {
  jobId: string
  jobClass: JobClass
  input: unknown
  // When the attempt's token expires: nothing may be started that cannot end before it.
  deadline: Date
  // The owner's answers to the questions this job asked on earlier attempts, oldest first (spec 9). The step that
  // decides whether to ask must carry them in its request (in its messages, say): a step whose request is unchanged
  // replays its checkpoint on the next attempt, decides the same way again, and asks again after every answer.
  answers: AgentAnswer[]
  // Asks the owner instead of guessing what blocks the job's output: the question is posted, and JobWaiting ends
  // the job without a result. Its next attempt, started by the answer, finds the answer in `answers`; the step that
  // led to the question must then see it in its request (above), or it replays and asks again.
  ask(question: AgentQuestion): Promise<never>
  // One model call as a step: checkpointed, never sent again once saved, stopped by cancel or hold.
  modelStep(step: string, request: ModelRequest): Promise<ModelStepResult>
  // Called between steps: throws JobStopped when the job was cancelled or held.
  // `allowHeld`: stop only for a cancel (used before the result is posted, when a held job still posts so
  // the core keeps the paid-for result).
  checkStop(options?: { allowHeld?: boolean }): Promise<void>
  // The brand documents the job lists (its input.documentIds), read through the core with the attempt token.
  document(documentId: string): Promise<{ mediaType: string; bytes: Buffer }>
  documents(): Promise<JobDocument[]>
  documentPart(
    documentId: string,
    partNo: number,
  ): Promise<{ firstPage: number; lastPage: number; bytes: Buffer }>
}
export type JobHandler = (ctx: JobContext) => Promise<{ type: string; result: unknown }>

// A registered handler and the agent files it runs on. `agent` is null for a handler that loads no agent files
// (it makes no model call from them); `filesHash` is agentFilesHash of those files, computed once at startup.
export interface HandlerEntry {
  handler: JobHandler
  agent: string | null
  filesHash: string | null
}

export interface RunnerDeps {
  core: CoreClient
  model: ModelClient
  handlers: Record<string, HandlerEntry>
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
    outputSchema: request.outputSchema ?? null,
    // Added only when present, so a request without tools hashes as it did before tools existed.
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
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
  // Held (by a kill switch or a hold), a queue copy a release has replaced, or a job waiting for the owner's
  // answer: no attempt was made; stop and post nothing.
  if ('outcome' in started) return
  const entry = deps.handlers[started.expectedResultType]
  if (!entry) throw new Error(`no handler for ${started.expectedResultType}`)
  const { handler } = entry

  // Ruling R9: the worker runs only the released agent files. A handler that names an agent runs only a job
  // that recorded the same agent and files hash (a job made before they were recorded carries neither and is
  // refused). A handler that names none runs whatever the job carries. On a mismatch no model call is made:
  // the attempt is ended, and the error makes the queue retry; when it gives up, the dead-letter watcher marks the
  // job dead as for any failure.
  if (entry.agent !== null && (started.agent !== entry.agent || started.filesHash !== entry.filesHash)) {
    await deps.core.endAttempt(job.id, started.token, 'agent_files_mismatch')
    throw new Error(
      `agent_files_mismatch: job ${job.id} was released with ${started.agent ?? 'no agent'} files ${
        started.filesHash ?? 'none'
      }, this worker runs ${entry.agent} files ${entry.filesHash ?? 'none'}`,
    )
  }

  const ctx: JobContext = {
    jobId: job.id,
    jobClass: job.jobClass,
    input: started.input,
    deadline: started.expiresAt === undefined ? new Date(8.64e15) : new Date(started.expiresAt * 1000),
    answers: started.answers ?? [],
    async ask(question) {
      const { questionId } = await deps.core.raiseQuestion(job.id, started.token, question)
      throw new JobWaiting(questionId)
    },
    async checkStop(options) {
      const control = await deps.core.control(job.id, started.token)
      if (control.cancelRequested) throw new JobStopped('cancelled')
      if (control.held && !options?.allowHeld) throw new JobStopped('held')
    },
    document: (documentId) => deps.core.document(job.id, started.token, documentId),
    documents: () => deps.core.documents(job.id, started.token),
    documentPart: (documentId, partNo) => deps.core.documentPart(job.id, started.token, documentId, partNo),
    async modelStep(step, request) {
      const registered = await deps.core.registerModelCall(job.id, started.token, {
        step,
        requestHash: requestHash(request),
        model: request.model,
      })
      if (registered.outcome === 'use_checkpoint') return replayed(registered.output)
      if (registered.outcome === 'cancelled' || registered.outcome === 'held') {
        throw new JobStopped(registered.outcome)
      }

      // An empty system prompt and none are the same request, and are sent the same way.
      const sent: ModelRequest = { ...request }
      if (!sent.system) delete sent.system
      const classTimeout = TIMEOUT_MS_BY_CLASS[started.jobClass]
      if (sent.timeoutMs === undefined && classTimeout !== undefined) sent.timeoutMs = classTimeout

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
      // pause_turn is a normal reply: the provider paused a long turn, and the handler sends it back.
      const paused = reply.stopReason === 'pause_turn'
      const toolStep = isToolStep(request)
      // A tools request must come back with its content blocks: without them a continuation would send an
      // empty assistant turn. Treated as a stop (the call is costed) and then an error.
      const missingContent = (request.tools?.length ?? 0) > 0 && reply.content === undefined
      const stopped = (reply.stopReason !== 'end_turn' && !paused) || missingContent
      const content = reply.content ?? []
      // A reply that did not end its turn was still paid for: the call is completed and costed (no step is
      // saved, so a retry asks again), and only then does the job stop. It is not failCall: that means the
      // provider refused and did no work.
      let output: unknown = null
      if (!stopped) {
        output = toolStep
          ? // A tool step is saved as a JSON string (text may hold U+0000, which JSON escapes), with the
            // provider's own counts, so a replay gives the same budget as the first attempt.
            JSON.stringify({
              text: reply.text,
              content,
              stopReason: reply.stopReason,
              serverToolSearches: reply.usage.serverToolSearches ?? 0,
              serverToolFetches: reply.usage.serverToolFetches ?? 0,
            })
          : { text: reply.text, stopReason: reply.stopReason }
      }
      const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = reply.usage
      const counts = serverCounts(reply.usage)
      const full = {
        step,
        output,
        ...(stopped ? { stopped: true as const } : {}),
        model: request.model,
        providerMessageId: reply.messageId,
        providerRequestId: reply.requestId,
        usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, ...counts },
      }
      // Measured as it will be sent. Too large: costed without its output, then StepTooLarge below.
      const bytes = stopped ? 0 : Buffer.byteLength(JSON.stringify(full))
      const tooLarge = bytes > CHECKPOINT_MAX_BYTES
      const body = tooLarge ? { ...full, output: null, stopped: true as const } : full
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
      if (missingContent)
        throw new Error('the model reply carried no content blocks for a request with tools')
      if (stopped) throw new ModelStopped(reply.stopReason)
      if (tooLarge) throw new StepTooLarge(step, bytes)
      return {
        text: reply.text,
        stopReason: reply.stopReason,
        content,
        usage: { ...NO_USAGE, ...reply.usage, ...serverCounts(reply.usage) },
      }
    },
  }

  try {
    const outcome = await handler(ctx)
    // A cancel that arrived while the last step ran is seen here, before the result is posted. A hold is not:
    // the result is posted anyway and the core stores it as held (spec 9.4), so the work is not lost.
    await ctx.checkStop({ allowHeld: true })
    await deps.core.postResult(job.id, started.token, outcome)
  } catch (error) {
    // A job waiting for an answer ends here, posting nothing, and its queue row completes: the core already ended
    // the attempt, and the answer sends the job again.
    if (error instanceof JobWaiting) return
    // A cancelled or held job ends here without a retry: the core already knows.
    if (error instanceof JobStopped) {
      // A held job's attempt is ended, so a release starts a fresh attempt instead of finding a live one. A
      // failure to say so is not worth failing the stop for: the next attempt supersedes this one anyway.
      if (error.why === 'held') {
        try {
          await deps.core.endAttempt(job.id, started.token, 'held')
        } catch {
          // Nothing to add: the attempt stays active until the next one supersedes it.
        }
      }
      return
    }
    // The cancel can also arrive between the check and the post: the core refuses the result with 409.
    if (error instanceof CoreError && error.status === 409 && error.code === 'job_cancelled') return
    throw error
  }
}
