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
import { readJobDocument } from '../onboarding/documents.ts'
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
const callParams = z.strictObject({ jobId: z.uuid(), callId: z.uuid() })

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
        res
          .status(200)
          .set('content-type', document.mediaType)
          .set('cache-control', 'no-store')
          .send(document.bytes)
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
        'The worker timer sends due approval reminders and marks and escalates overdue requests, and stamps the worker heartbeat; it never approves or changes a version',
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
          res.json(await approvalsTick(notify.pool, notify))
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
