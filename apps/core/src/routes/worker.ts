import express from 'express'
import { z } from 'zod'
import { withBrand } from '@mkt/db'
import { claimsOf } from '../access/worker-auth.ts'
import type { RouteTable } from '../access/routes.ts'
import { markDead, sweepModelCalls, unmarkedDead } from '../jobs/dead.ts'
import {
  endAttempt,
  failModelCall,
  postResult,
  readControl,
  registerModelCall,
  requireCurrentAttempt,
  saveCheckpoint,
  startAttempt,
  type JobsDeps,
} from '../jobs/service.ts'
import { raiseAgentQuestion, remindAgentQuestions } from '../onboarding/agent-questions.ts'
import { listJobDocuments, readJobDocument, readJobDocumentPart } from '../onboarding/documents.ts'
import { tick as approvalsTick } from '../approvals/requests.ts'
import { runNotifyTick } from '../notify/tick.ts'
import { errorName, type NotifyDeps } from '../notify/ports.ts'
import { inputOf, validate } from '../validate.ts'

const jobParams = z.strictObject({ jobId: z.uuid() })
// queueId: the queue row the worker claimed (optional, so an older worker is still understood).
const startBody = z.strictObject({ workerId: z.string().min(1).max(200), queueId: z.uuid().optional() })

// jsonb and text columns reject U+0000; refusing it here is a 400 instead of a 500 after the provider call.
const hasNul = (value: unknown): boolean => {
  if (typeof value === 'string') return value.includes('\u0000')
  if (Array.isArray(value)) return value.some(hasNul)
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => hasNul(k) || hasNul(v))
  }
  return false
}
const noNul = (v: unknown) => !hasNul(v)
const text = (max: number) => z.string().min(1).max(max).refine(noNul, 'must not contain U+0000')
const count = z.number().int().min(0).max(2147483647)

const registerBody = z.strictObject({
  step: text(200),
  requestHash: text(200),
  model: text(200),
})
const checkpointBody = z.strictObject({
  step: text(200),
  output: z.json().refine(noNul, 'must not contain U+0000'),
  stopped: z.literal(true).optional(),
  model: text(200),
  providerMessageId: text(200),
  providerRequestId: z.string().max(200).refine(noNul, 'must not contain U+0000').nullable(),
  usage: z.strictObject({
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
    // Old workers do not send these; absent means none.
    serverToolSearches: count.default(0),
    serverToolFetches: count.default(0),
  }),
})
const resultBody = z.strictObject({
  type: text(100),
  result: z.json().refine(noNul, 'must not contain U+0000'),
})
const tickBody = z.strictObject({ workerId: z.string().min(1).max(200) })
const unmarkedBody = z.strictObject({ jobIds: z.array(z.uuid()).max(500) })
const endBody = z.strictObject({ reason: z.enum(['held', 'agent_files_mismatch']) })
const failureBody = z.strictObject({ error: text(2000) })
const documentParams = z.strictObject({ jobId: z.uuid(), documentId: z.uuid() })
const partParams = z.strictObject({
  jobId: z.uuid(),
  documentId: z.uuid(),
  partNo: z
    .string()
    .regex(/^[0-9]{1,9}$/)
    .transform(Number),
})
const callParams = z.strictObject({ jobId: z.uuid(), callId: z.uuid() })
// Spec 9: what an agent asks when it cannot settle something, with why, and options with a suggestion where it can.
const questionBody = z.strictObject({
  question: text(500),
  why: text(300),
  options: z.array(text(200)).max(5),
  suggested: text(500).nullable(),
})

export function registerWorkerRoutes(table: RouteTable, deps: JobsDeps, notify?: NotifyDeps): void {
  table.add({
    method: 'post',
    path: '/worker/jobs/:jobId/attempts',
    access: { kind: 'worker' },
    summary: 'A worker starts an attempt on a job it has claimed and receives its input and attempt token',
    handlers: [
      validate({ params: jobParams, body: startBody }),
      async (_req, res) => {
        const { params, body } = inputOf<{
          params: z.infer<typeof jobParams>
          body: z.infer<typeof startBody>
        }>(res)
        res.json(await startAttempt(deps, params.jobId, body.workerId, body.queueId))
      },
    ],
  })

  table.add({
    method: 'get',
    path: '/worker/jobs/:jobId/control',
    access: { kind: 'attempt' },
    summary: 'A worker reads whether its job is cancelled or held',
    handlers: [
      validate({ params: jobParams }),
      async (_req, res) => {
        const claims = claimsOf(res)
        res.json(
          await withBrand(deps.pool, claims.brandId, async (client) => {
            await requireCurrentAttempt(client, deps, claims)
            return readControl(client, claims.jobId)
          }),
        )
      },
    ],
  })

  // The bytes of a brand document the job's input lists, for the job's own brand only.
  table.add({
    method: 'get',
    path: '/worker/jobs/:jobId/documents/:documentId',
    access: { kind: 'attempt' },
    summary: "A worker reads the bytes of a brand document listed in its job's input",
    handlers: [
      validate({ params: documentParams }),
      async (_req, res) => {
        const claims = claimsOf(res)
        const { params } = inputOf<{ params: z.infer<typeof documentParams> }>(res)
        const document = await withBrand(deps.pool, claims.brandId, async (client) => {
          await requireCurrentAttempt(client, deps, claims)
          return readJobDocument(client, {
            jobId: claims.jobId,
            brandId: claims.brandId,
            documentId: params.documentId,
          })
        })
        // res.end, not res.send: send would hash the whole body (up to 100 MB) for an ETag nobody uses.
        res
          .status(200)
          .set({
            'content-type': document.mediaType,
            'content-length': String(document.bytes.length),
            'cache-control': 'no-store',
          })
          .end(document.bytes)
      },
    ],
  })

  // The job's documents with the parts of each, so a worker knows what to read.
  table.add({
    method: 'get',
    path: '/worker/jobs/:jobId/documents',
    access: { kind: 'attempt' },
    summary: "A worker lists the brand documents in its job's input, with the AI-ready parts of each",
    handlers: [
      validate({ params: jobParams }),
      async (_req, res) => {
        const claims = claimsOf(res)
        const documents = await withBrand(deps.pool, claims.brandId, async (client) => {
          await requireCurrentAttempt(client, deps, claims)
          return listJobDocuments(client, { jobId: claims.jobId, brandId: claims.brandId })
        })
        res.json(documents)
      },
    ],
  })

  // One part of a listed document: whole pages of the PDF, at most 8 MB, the pages named in the headers.
  table.add({
    method: 'get',
    path: '/worker/jobs/:jobId/documents/:documentId/parts/:partNo',
    access: { kind: 'attempt' },
    summary: "A worker reads one AI-ready part of a brand document listed in its job's input",
    handlers: [
      validate({ params: partParams }),
      async (_req, res) => {
        const claims = claimsOf(res)
        const { params } = inputOf<{ params: z.infer<typeof partParams> }>(res)
        const part = await withBrand(deps.pool, claims.brandId, async (client) => {
          await requireCurrentAttempt(client, deps, claims)
          return readJobDocumentPart(client, {
            jobId: claims.jobId,
            brandId: claims.brandId,
            documentId: params.documentId,
            partNo: params.partNo,
          })
        })
        res
          .status(200)
          .set({
            'content-type': 'application/pdf',
            'content-length': String(part.bytes.length),
            'cache-control': 'no-store',
            'x-first-page': String(part.firstPage),
            'x-last-page': String(part.lastPage),
          })
          .end(part.bytes)
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/worker/jobs/:jobId/model-calls',
    access: { kind: 'attempt' },
    summary: 'A worker registers a model call before it sends the request',
    handlers: [
      validate({ params: jobParams, body: registerBody }),
      async (_req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof registerBody> }>(res)
        res.json(await registerModelCall(deps, claimsOf(res), body))
      },
    ],
  })

  // The global JSON parser (100 kB) skips exactly this request (see app.ts); the 8 MB parser runs here (research steps keep search results and page text), after
  // the worker credential and the attempt token have been checked, so nothing large is read for a stranger.
  table.add({
    method: 'post',
    path: '/worker/jobs/:jobId/model-calls/:callId/checkpoint',
    access: { kind: 'attempt' },
    summary: 'A worker saves a step and its cost in one transaction',
    handlers: [
      express.json({ limit: '8mb', strict: true }),
      validate({ params: callParams, body: checkpointBody }),
      async (_req, res) => {
        const { params, body } = inputOf<{
          params: z.infer<typeof callParams>
          body: z.infer<typeof checkpointBody>
        }>(res)
        res.json(await saveCheckpoint(deps, claimsOf(res), { ...body, callId: params.callId }))
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/worker/jobs/:jobId/model-calls/:callId/failure',
    access: { kind: 'attempt' },
    summary: 'A worker marks a model request that failed',
    handlers: [
      validate({ params: callParams, body: failureBody }),
      async (_req, res) => {
        const { params, body } = inputOf<{
          params: z.infer<typeof callParams>
          body: z.infer<typeof failureBody>
        }>(res)
        await failModelCall(deps, claimsOf(res), params.callId, body.error)
        res.status(204).end()
      },
    ],
  })

  // The global 100 kB parser applies here. A held answer is 202 (kept, not applied); applied and repeated are 200.
  table.add({
    method: 'post',
    path: '/worker/jobs/:jobId/result',
    access: { kind: 'attempt' },
    summary: 'A worker posts the job result, which is applied once, repeated safely, or held',
    handlers: [
      validate({ params: jobParams, body: resultBody }),
      async (_req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof resultBody> }>(res)
        const answer = await postResult(deps, claimsOf(res), body)
        res.status(answer.status === 'held' ? 202 : 200).json(answer)
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/worker/jobs/:jobId/attempt/end',
    access: { kind: 'attempt' },
    summary:
      "A worker ends its current attempt because the job is held or its agent files differ from the job's",
    handlers: [
      validate({ params: jobParams, body: endBody }),
      async (_req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof endBody> }>(res)
        await endAttempt(deps, claimsOf(res), body.reason)
        res.status(204).end()
      },
    ],
  })

  // The attempt ends with the question, and the job waits for the owner's answer (spec 9). 201 with the question id.
  table.add({
    method: 'post',
    path: '/worker/jobs/:jobId/question',
    access: { kind: 'attempt' },
    summary:
      "A worker asks the owner what its job cannot settle; the attempt ends and the job waits for the owner's answer",
    handlers: [
      validate({ params: jobParams, body: questionBody }),
      async (_req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof questionBody> }>(res)
        res.status(201).json(await raiseAgentQuestion(deps, claimsOf(res), body))
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/worker/jobs/:jobId/dead',
    access: { kind: 'worker' },
    summary: 'The dead-letter watcher reports a job the queue gave up on',
    handlers: [
      validate({ params: jobParams }),
      async (_req, res) => {
        const { params } = inputOf<{ params: z.infer<typeof jobParams> }>(res)
        await markDead(deps, params.jobId)
        res.status(204).end()
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/worker/reconcile',
    access: { kind: 'worker' },
    summary:
      'The worker timer marks model calls left started past their class expiry as unknown, then raises and delivers alerts and notifications',
    handlers: [
      async (_req, res) => {
        const marked = await sweepModelCalls(deps)
        // The timer's other work, after the sweep and never in its way: each stage isolated, one budget.
        if (notify) await runNotifyTick(notify)
        res.json({ marked })
      },
    ],
  })

  // Reminders and escalation for open approval requests; the worker timer calls it. Counts only in the answer.
  if (notify) {
    table.add({
      method: 'post',
      path: '/worker/approvals/tick',
      access: { kind: 'worker' },
      summary:
        'The worker timer sends due approval reminders, marks and escalates overdue requests, reminds unanswered agent questions, and stamps the worker heartbeat; it never approves or changes a version',
      handlers: [
        validate({ body: tickBody }),
        async (_req, res) => {
          const { body } = inputOf<{ body: z.infer<typeof tickBody> }>(res)
          // The timer's call is the worker's heartbeat (/health/worker). A failed stamp is logged and never
          // stops the tick.
          try {
            await notify.pool.query('select app.stamp_worker($1)', [body.workerId])
          } catch (error) {
            notify.logger?.error({ err: errorName(error) }, 'worker heartbeat not stamped')
          }
          const approvals = await approvalsTick(notify.pool, notify)
          // Agent questions unanswered for 72 hours ride the same timer (spec 9).
          const agentQuestionsReminded = await remindAgentQuestions(
            notify.pool,
            notify.clock.now(),
            notify.logger,
          )
          res.json({ ...approvals, agentQuestionsReminded })
        },
      ],
    })
  }

  table.add({
    method: 'post',
    path: '/worker/dead/unmarked',
    access: { kind: 'worker' },
    summary: 'The worker asks which of the jobs the queue shows as failed the core has not marked dead',
    handlers: [
      validate({ body: unmarkedBody }),
      async (_req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof unmarkedBody> }>(res)
        res.json({ jobIds: await unmarkedDead(deps, body.jobIds) })
      },
    ],
  })
}
