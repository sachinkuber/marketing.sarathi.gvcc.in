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
  agent: string | null
  filesHash: string | null
  // When the attempt token expires, in epoch seconds. Absent from a core that does not send it.
  expiresAt?: number
  // The owner's answers to the questions the job asked, oldest first. Absent from a core that does not send them.
  answers?: AgentAnswer[]
}
// The owner's answer to a question an earlier attempt of the job asked (spec 9), with the owner statement that
// records it, so an agent can cite the answer as a source (ruling R11).
export interface AgentAnswer {
  question: string
  why: string
  options: string[]
  answer: string
  sourceId: string
}
// What a job asks the owner when it cannot settle something: why, and options with a suggestion where it can.
export interface AgentQuestion {
  question: string
  why: string
  options: string[]
  suggested: string | null
}
export type Registered =
  | { outcome: 'send'; callId: string; possibleDuplicate: boolean }
  | { outcome: 'use_checkpoint'; output: unknown }
  | { outcome: 'cancelled' }
  | { outcome: 'held' }
export interface CheckpointBody {
  step: string
  output: unknown
  // Set when the reply did not end its turn: the core costs the call and saves no step.
  stopped?: true
  model: string
  providerMessageId: string
  providerRequestId: string | null
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    serverToolSearches: number
    serverToolFetches: number
  }
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
    | { finished: false; outcome: 'held' | 'superseded' | 'waiting_for_answer' }
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
  // The attempt stopped because its job is held: the core ends it, so a release starts a fresh one.
  endAttempt(jobId: string, token: string, reason: 'held' | 'agent_files_mismatch'): Promise<void>
  // The job asks the owner: the core stores the question and ends the attempt, and the job waits for the answer.
  raiseQuestion(jobId: string, token: string, body: AgentQuestion): Promise<{ questionId: string }>
  // Worker-level calls (no attempt token): the dead-letter watcher and the reconciliation timer (task 10).
  jobDead(jobId: string): Promise<void>
  reconcile(): Promise<{ marked: number }>
  // Of these failed job IDs, the ones the core has not yet marked dead.
  unmarkedDead(jobIds: string[]): Promise<string[]>
  // A brand document listed in the job's input: its stored media type and bytes (task 5).
  document(jobId: string, token: string, documentId: string): Promise<{ mediaType: string; bytes: Buffer }>
  // The documents the job lists, each with the AI-ready parts of a large PDF (task 5b; none when it is read whole).
  documents(jobId: string, token: string): Promise<JobDocument[]>
  // One part of such a PDF: whole pages, at most 8 MB.
  documentPart(
    jobId: string,
    token: string,
    documentId: string,
    partNo: number,
  ): Promise<{ firstPage: number; lastPage: number; bytes: Buffer }>
  // The approvals timer: the core sends due reminders and marks and escalates overdue requests.
  // Unanswered agent questions are reminded on the same call (absent from a core that does not). Their failed
  // brands are null when that sweep could not start.
  approvalsTick(workerId: string): Promise<{
    reminded: number
    overdue: number
    escalated: number
    failedBrands: number
    agentQuestionsReminded?: number
    agentQuestionsFailedBrands?: number | null
  }>
}

export interface JobDocument {
  id: string
  fileName: string
  mediaType: string
  sizeBytes: number
  parts: { partNo: number; firstPage: number; lastPage: number; sizeBytes: number }[]
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
    z.object({ finished: z.literal(false), outcome: z.enum(['held', 'superseded', 'waiting_for_answer']) }),
    z.object({
      finished: z.literal(false),
      attemptId: z.string().min(1),
      attemptNumber: z.number().int(),
      token: z.string().min(1),
      input: z.unknown(),
      savedSteps: z.array(z.unknown()),
      expectedResultType: z.string().min(1),
      jobClass: z.enum(JOB_CLASSES),
      agent: z.string().nullable(),
      filesHash: z.string().nullable(),
      expiresAt: z.number().int().optional(),
      answers: z
        .array(
          z.object({
            question: z.string(),
            why: z.string(),
            options: z.array(z.string()),
            answer: z.string(),
            sourceId: z.string().min(1),
          }),
        )
        .optional(),
    }),
  ]),
  checkpoint: z.object({ costed: z.boolean() }),
  postResult: z.object({ status: z.enum(['applied', 'repeated', 'held']) }),
  raiseQuestion: z.object({ questionId: z.string().min(1) }),
  reconcile: z.object({ marked: z.number().int().min(0) }),
  approvalsTick: z.object({
    reminded: z.number().int().min(0),
    overdue: z.number().int().min(0),
    escalated: z.number().int().min(0),
    failedBrands: z.number().int().min(0),
    agentQuestionsReminded: z.number().int().min(0).optional(),
    agentQuestionsFailedBrands: z.number().int().min(0).nullable().optional(),
  }),
  unmarkedDead: z.object({ jobIds: z.array(z.string()) }),
  documents: z.array(
    z.object({
      id: z.string().min(1),
      fileName: z.string(),
      mediaType: z.string(),
      sizeBytes: z.number().int(),
      parts: z.array(
        z.object({
          partNo: z.number().int(),
          firstPage: z.number().int(),
          lastPage: z.number().int(),
          sizeBytes: z.number().int(),
        }),
      ),
    }),
  ),
}

function parseReply<T>(schema: z.ZodType, reply: unknown, what: string): T {
  const parsed = schema.safeParse(reply)
  if (!parsed.success) throw new Error(`The core answered ${what} with an unexpected reply.`)
  return parsed.data as T
}

// Every call to the core is bounded: a hung connection must not hold a job slot until the queue expires it.
const REQUEST_TIMEOUT_MS = 60_000
const DOCUMENT_TIMEOUT_MS = 300_000

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
  async function fetchBytes(path: string, token: string): Promise<Response> {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      headers: { authorization: `Worker ${workerSecret}`, 'x-attempt-token': token },
      signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
    })
    if (!response.ok) {
      const json = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string }
      }
      throw new CoreError(
        response.status,
        json.error?.code ?? 'error',
        json.error?.message ?? response.statusText,
      )
    }
    return response
  }
  return {
    // The calls whose answer is bytes, not JSON. A longer bound than a JSON call: a document can be 100 MB.
    async document(jobId, token, documentId) {
      const response = await fetchBytes(`/worker/jobs/${jobId}/documents/${documentId}`, token)
      const mediaType = response.headers.get('content-type')
      if (!mediaType) throw new Error('The core answered a document with no content type.')
      return { mediaType, bytes: Buffer.from(await response.arrayBuffer()) }
    },
    async documents(jobId, token) {
      const reply = await call('GET', `/worker/jobs/${jobId}/documents`, token)
      return parseReply<JobDocument[]>(replySchemas.documents, reply, 'a document list')
    },
    async documentPart(jobId, token, documentId, partNo) {
      const response = await fetchBytes(
        `/worker/jobs/${jobId}/documents/${documentId}/parts/${partNo}`,
        token,
      )
      const firstPage = Number(response.headers.get('x-first-page'))
      const lastPage = Number(response.headers.get('x-last-page'))
      if (
        !Number.isInteger(firstPage) ||
        !Number.isInteger(lastPage) ||
        firstPage < 1 ||
        lastPage < firstPage
      ) {
        throw new Error('The core answered a document part with no page range.')
      }
      return { firstPage, lastPage, bytes: Buffer.from(await response.arrayBuffer()) }
    },
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
    endAttempt: (jobId, token, reason) =>
      call('POST', `/worker/jobs/${jobId}/attempt/end`, token, { reason }),
    async raiseQuestion(jobId, token, body) {
      const reply = await call('POST', `/worker/jobs/${jobId}/question`, token, body)
      return parseReply(replySchemas.raiseQuestion, reply, 'a question')
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
    async approvalsTick(workerId) {
      const reply = await call('POST', '/worker/approvals/tick', null, { workerId })
      return parseReply(replySchemas.approvalsTick, reply, 'an approvals tick')
    },
  }
}
