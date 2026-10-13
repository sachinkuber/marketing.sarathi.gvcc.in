import type { JobClass } from '@mkt/queue'
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
  startAttempt(
    jobId: string,
    workerId: string,
  ): Promise<StartedAttempt | { finished: true; outcome: unknown }>
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
}

const registeredSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('send'), callId: z.string().min(1), possibleDuplicate: z.boolean() }),
  z.object({ outcome: z.literal('use_checkpoint'), output: z.unknown() }),
  z.object({ outcome: z.literal('cancelled') }),
  z.object({ outcome: z.literal('held') }),
])

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
    startAttempt: (jobId, workerId) => call('POST', `/worker/jobs/${jobId}/attempts`, null, { workerId }),
    control: (jobId, token) => call('GET', `/worker/jobs/${jobId}/control`, token),
    async registerModelCall(jobId, token, input) {
      const reply = await call('POST', `/worker/jobs/${jobId}/model-calls`, token, input)
      const parsed = registeredSchema.safeParse(reply)
      if (!parsed.success) {
        throw new Error('The core answered a model call registration with an unknown reply.')
      }
      return parsed.data as Registered
    },
    checkpoint: (jobId, token, callId, input) =>
      call('POST', `/worker/jobs/${jobId}/model-calls/${callId}/checkpoint`, token, input),
    failCall: (jobId, token, callId, error) =>
      call('POST', `/worker/jobs/${jobId}/model-calls/${callId}/failure`, token, { error }),
    postResult: (jobId, token, posted) => call('POST', `/worker/jobs/${jobId}/result`, token, posted),
    jobDead: (jobId) => call('POST', `/worker/jobs/${jobId}/dead`, null, {}),
    reconcile: () => call('POST', '/worker/reconcile', null, {}),
  }
}
