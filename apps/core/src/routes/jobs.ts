import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { principalOf } from '../auth/session.ts'
import { cancelJob, listDead, requeueJob } from '../jobs/dead.ts'
import type { JobsDeps } from '../jobs/service.ts'
import { inputOf, validate } from '../validate.ts'

const brandParams = z.strictObject({ brandId: z.uuid() })
const jobParams = z.strictObject({ brandId: z.uuid(), jobId: z.uuid() })

// The dead-letter list is the platform owner's: seeing and acting on another brand's failed work is the
// see_other_brands permission (plan decision 7).
export function registerJobRoutes(table: RouteTable, deps: JobsDeps): void {
  table.add({
    method: 'get',
    path: '/brands/:brandId/jobs/dead',
    access: { kind: 'permission', permission: 'see_other_brands' },
    summary: 'The jobs of a brand that the queue gave up on',
    handlers: [
      validate({ params: brandParams }),
      async (_req, res) => {
        res.json(await listDead(deps, brandContextOf(res).brandId))
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/jobs/:jobId/requeue',
    access: { kind: 'permission', permission: 'see_other_brands' },
    summary: 'Run a dead job again',
    handlers: [
      validate({ params: jobParams }),
      async (_req, res) => {
        const { params } = inputOf<{ params: z.infer<typeof jobParams> }>(res)
        await requeueJob(deps, brandContextOf(res).brandId, params.jobId, principalOf(res).userId)
        res.status(204).end()
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/jobs/:jobId/cancel',
    access: { kind: 'permission', permission: 'see_other_brands' },
    summary: 'Give up on a dead job and end its run',
    handlers: [
      validate({ params: jobParams }),
      async (_req, res) => {
        const { params } = inputOf<{ params: z.infer<typeof jobParams> }>(res)
        await cancelJob(deps, brandContextOf(res).brandId, params.jobId, principalOf(res).userId)
        res.status(204).end()
      },
    ],
  })
}
