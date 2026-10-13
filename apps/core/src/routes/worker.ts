import { z } from 'zod'
import { withBrand } from '@mkt/db'
import { claimsOf } from '../access/worker-auth.ts'
import type { RouteTable } from '../access/routes.ts'
import { readControl, requireCurrentAttempt, startAttempt, type JobsDeps } from '../jobs/service.ts'
import { inputOf, validate } from '../validate.ts'

const jobParams = z.strictObject({ jobId: z.uuid() })
const startBody = z.strictObject({ workerId: z.string().min(1).max(200) })

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
}
