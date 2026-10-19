import { briefSchema } from '@mkt/shared'
import { z } from 'zod'
import { startSummaryRun } from '../agents/start.ts'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { principalOf } from '../auth/session.ts'
import type { JobsDeps } from '../jobs/service.ts'
import { inputOf, validate } from '../validate.ts'

const brandParams = z.strictObject({ brandId: z.uuid() })

// Starting an agent spends money, so it is the platform owner's for now (plan decision 5): the permission is
// see_other_brands, which only the platform owner holds.
export function registerAgentRoutes(table: RouteTable, deps: JobsDeps): void {
  table.add({
    method: 'post',
    path: '/brands/:brandId/agents/summary/runs',
    access: { kind: 'permission', permission: 'see_other_brands' },
    summary: 'Start the summary agent on a brief',
    handlers: [
      validate({ params: brandParams, body: briefSchema }),
      async (_req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof briefSchema> }>(res)
        const started = await startSummaryRun(deps.pool, deps, {
          brandId: brandContextOf(res).brandId,
          brief: body.brief,
          actor: { userId: principalOf(res).userId },
        })
        res.status(201).json(started)
      },
    ],
  })
}
