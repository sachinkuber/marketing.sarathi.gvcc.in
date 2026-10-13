import { z } from 'zod'
import { withBrand } from '@mkt/db'
import { claimsOf } from '../access/worker-auth.ts'
import type { RouteTable } from '../access/routes.ts'
import {
  failModelCall,
  readControl,
  registerModelCall,
  requireCurrentAttempt,
  saveCheckpoint,
  startAttempt,
  type JobsDeps,
} from '../jobs/service.ts'
import { inputOf, validate } from '../validate.ts'

const jobParams = z.strictObject({ jobId: z.uuid() })
const startBody = z.strictObject({ workerId: z.string().min(1).max(200) })

const registerBody = z.strictObject({
  step: z.string().min(1).max(200),
  requestHash: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
})
const checkpointBody = z.strictObject({
  step: z.string().min(1).max(200),
  output: z.json(),
  model: z.string().min(1).max(200),
  providerMessageId: z.string().min(1).max(200),
  providerRequestId: z.string().max(200).nullable(),
  usage: z.strictObject({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    cacheReadTokens: z.number().int().min(0),
    cacheWriteTokens: z.number().int().min(0),
  }),
})
const failureBody = z.strictObject({ error: z.string().min(1).max(2000) })
const callParams = z.strictObject({ jobId: z.uuid(), callId: z.uuid() })

export function registerWorkerRoutes(table: RouteTable, deps: JobsDeps): void {
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

  // The global JSON parser allows 100 kB; app.ts mounts a 1 MB parser for exactly this path before it.
  table.add({
    method: 'post',
    path: '/worker/jobs/:jobId/model-calls/:callId/checkpoint',
    access: { kind: 'attempt' },
    summary: 'A worker saves a step and its cost in one transaction',
    handlers: [
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
}
