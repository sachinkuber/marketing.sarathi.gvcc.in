import { JOB_CLASSES, type JobClass } from '@mkt/queue'
import { z } from 'zod'

export interface StartedAttempt {
  finished: false
  attemptId: string
  attemptNumber: number
  token: string
  input: unknown
  savedSteps: unknown[]
  expectedResultType: string
  jobClass: JobClass
}
export type Registered =
  | { outcome: 'send'; callId: string; possibleDuplicate: boolean }
  | { outcome: 'use_checkpoint'; output: unknown }
  | { outcome: 'cancelled' }
  | { outcome: 'held' }
export interface CheckpointBody {
  step: string
  output: unknown
  model: string
  providerMessageId: string
  providerRequestId: string | null
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
}
export interface CoreClient {
  // `queueId`: the queue row the worker claimed, so the core can turn away a copy a release has replaced.
  startAttempt(
    jobId: string,
    workerId: string,
    queueId?: string,
  ): Promise<
    | StartedAttempt
    | { finished: true; outcome: unknown }
    | { finished: false; outcome: 'held' | 'superseded' }
  >
  control(jobId: string, token: string): Promise<{ cancelRequested: boolean; held: boolean }>
  registerModelCall(
    jobId: string,
    token: string,
    input: { step: string; requestHash: string; model: string },
  ): Promise<Registered>
  checkpoint(
    jobId: string,
    token: string,
    callId: string,
    input: CheckpointBody,
  ): Promise<{ costed: boolean }>
  failCall(jobId: string, token: string, callId: string, error: string): Promise<void>
  postResult(
    jobId: string,
    token: string,
    posted: { type: string; result: unknown },
  ): Promise<{ status: 'applied' | 'repeated' | 'held' }>
  // Worker-level calls (no attempt token): the dead-letter watcher and the reconciliation timer (task 10).
  jobDead(jobId: string): Promise<void>
  reconcile(): Promise<{ marked: number }>
  // Of these failed job IDs, the ones the core has not yet marked dead.
  unmarkedDead(jobIds: string[]): Promise<string[]>
  // The approvals timer: the core sends due reminders and marks and escalates overdue requests.
  approvalsTick(): Promise<{ reminded: number; overdue: number; escalated: number; failedBrands: number }>
}

// What the core may answer. Extra fields are accepted (the core can grow); a missing or unknown required
// field is an error, so a malformed reply never reads as a default (a missing cancelRequested is not "not
// cancelled").
export const replySchemas = {
  registered: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('send'), callId: z.string().min(1), possibleDuplicate: z.boolean() }),
    z.object({ outcome: z.literal('use_checkpoint'), output: z.unknown() }),
    z.object({ outcome: z.literal('cancelled') }),
    z.object({ outcome: z.literal('held') }),
  ]),
  control: z.object({ cancelRequested: z.boolean(), held: z.boolean() }),
  startAttempt: z.union([
    z.object({ finished: z.literal(true), outcome: z.unknown() }),
    z.object({ finished: z.literal(false), outcome: z.enum(['held', 'superseded']) }),
    z.object({
      finished: z.literal(false),
      attemptId: z.string().min(1),
      attemptNumber: z.number().int(),
      token: z.string().min(1),
      input: z.unknown(),
      savedSteps: z.array(z.unknown()),
      expectedResultType: z.string().min(1),
      jobClass: z.enum(JOB_CLASSES),
    }),
  ]),
  checkpoint: z.object({ costed: z.boolean() }),
  postResult: z.object({ status: z.enum(['applied', 'repeated', 'held']) }),
  reconcile: z.object({ marked: z.number().int().min(0) }),
  approvalsTick: z.object({
    reminded: z.number().int().min(0),
    overdue: z.number().int().min(0),
    escalated: z.number().int().min(0),
    failedBrands: z.number().int().min(0),
  }),
  unmarkedDead: z.object({ jobIds: z.array(z.string()) }),
}

function parseReply<T>(schema: z.ZodType, reply: unknown, what: string): T {
  const parsed = schema.safeParse(reply)
  if (!parsed.success) throw new Error(`The core answered ${what} with an unexpected reply.`)
  return parsed.data as T
}

// Every call to the core is bounded: a hung connection must not hold a job slot until the queue expires it.
const REQUEST_TIMEOUT_MS = 60_000

export class CoreError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function httpCoreClient(baseUrl: string, workerSecret: string): CoreClient {
  async function call<T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: `Worker ${workerSecret}`,
        ...(token ? { 'x-attempt-token': token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 204) return undefined as T
    const json = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string }
    }
    if (!response.ok) {
      throw new CoreError(
        response.status,
        json.error?.code ?? 'error',
        json.error?.message ?? response.statusText,
      )
    }
    return json as T
  }
  return {
    async startAttempt(jobId, workerId, queueId) {
      const reply = await call('POST', `/worker/jobs/${jobId}/attempts`, null, {
        workerId,
        ...(queueId === undefined ? {} : { queueId }),
      })
      return parseReply(replySchemas.startAttempt, reply, 'a start of attempt')
    },
    async control(jobId, token) {
      const reply = await call('GET', `/worker/jobs/${jobId}/control`, token)
      return parseReply(replySchemas.control, reply, 'a control read')
    },
    async registerModelCall(jobId, token, input) {
      const reply = await call('POST', `/worker/jobs/${jobId}/model-calls`, token, input)
      return parseReply(replySchemas.registered, reply, 'a model call registration')
    },
    async checkpoint(jobId, token, callId, input) {
      const reply = await call('POST', `/worker/jobs/${jobId}/model-calls/${callId}/checkpoint`, token, input)
      return parseReply(replySchemas.checkpoint, reply, 'a checkpoint')
    },
    failCall: (jobId, token, callId, error) =>
      call('POST', `/worker/jobs/${jobId}/model-calls/${callId}/failure`, token, { error }),
    async postResult(jobId, token, posted) {
      const reply = await call('POST', `/worker/jobs/${jobId}/result`, token, posted)
      return parseReply(replySchemas.postResult, reply, 'a result')
    },
    jobDead: (jobId) => call('POST', `/worker/jobs/${jobId}/dead`, null, {}),
    async unmarkedDead(jobIds) {
      if (jobIds.length === 0) return []
      const found: string[] = []
      for (let at = 0; at < jobIds.length; at += 500) {
        const reply = await call('POST', '/worker/dead/unmarked', null, {
          jobIds: jobIds.slice(at, at + 500),
        })
        found.push(
          ...parseReply<{ jobIds: string[] }>(replySchemas.unmarkedDead, reply, 'a dead check').jobIds,
        )
      }
      return found
    },
    async reconcile() {
      const reply = await call('POST', '/worker/reconcile', null, {})
      return parseReply(replySchemas.reconcile, reply, 'a reconciliation')
    },
    async approvalsTick() {
      const reply = await call('POST', '/worker/approvals/tick', null, {})
      return parseReply(replySchemas.approvalsTick, reply, 'an approvals tick')
    },
  }
}
