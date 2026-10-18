import express from 'express'
import { z } from 'zod'
import { withBrand } from '@mkt/db'
import { claimsOf } from '../access/worker-auth.ts'
import type { RouteTable } from '../access/routes.ts'
import { markDead, sweepModelCalls, unmarkedDead } from '../jobs/dead.ts'
import {
  failModelCall,
  postResult,
  readControl,
  registerModelCall,
  requireCurrentAttempt,
  saveCheckpoint,
  startAttempt,
  type JobsDeps,
} from '../jobs/service.ts'
import { alertOnOperationalFindings, retryAlerts } from '../notify/alerts.ts'
import { deliverPending } from '../notify/notifications.ts'
import type { NotifyDeps } from '../notify/ports.ts'
import { errorName } from '../notify/ports.ts'
import { inputOf, validate } from '../validate.ts'

const jobParams = z.strictObject({ jobId: z.uuid() })
const startBody = z.strictObject({ workerId: z.string().min(1).max(200) })

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
  model: text(200),
  providerMessageId: text(200),
  providerRequestId: z.string().max(200).refine(noNul, 'must not contain U+0000').nullable(),
  usage: z.strictObject({
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
  }),
})
const resultBody = z.strictObject({
  type: text(100),
  result: z.json().refine(noNul, 'must not contain U+0000'),
})
const unmarkedBody = z.strictObject({ jobIds: z.array(z.uuid()).max(500) })
const failureBody = z.strictObject({ error: text(2000) })
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
        res.json(await startAttempt(deps, params.jobId, body.workerId))
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

  // The global JSON parser (100 kB) skips exactly this request (see app.ts); the 1 MB parser runs here, after
  // the worker credential and the attempt token have been checked, so nothing large is read for a stranger.
  table.add({
    method: 'post',
    path: '/worker/jobs/:jobId/model-calls/:callId/checkpoint',
    access: { kind: 'attempt' },
    summary: 'A worker saves a step and its cost in one transaction',
    handlers: [
      express.json({ limit: '1mb', strict: true }),
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
        // The timer's other work, after the sweep and never in its way: alerts for what is dead, waiting or
        // unknown, a retry of the alerts no one has confirmed, and the queued notifications. A failure here
        // is logged by name and leaves the sweep's answer as it was.
        if (notify) {
          try {
            await alertOnOperationalFindings(notify.pool, notify)
            await retryAlerts(notify.pool, notify, 50)
            await deliverPending(notify.pool, notify, 50)
          } catch (error) {
            notify.logger?.error({ err: errorName(error) }, 'alert and notification delivery failed')
          }
        }
        res.json({ marked })
      },
    ],
  })

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
