import { withBrand, type Pool } from '@mkt/db'
import { z } from 'zod'
import { grantFor } from '../access/permissions.ts'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { awaitingApproval, homeResults, jobCounts, problemCounts } from '../agents/reads.ts'
import { validate } from '../validate.ts'

const params = z.strictObject({ brandId: z.uuid() })

export interface HomeRouteDeps {
  pool: Pool
  now: () => Date
}

// Every member sees the home screen, with the parts their role may not see left null: results and progress
// need edit_profile, the approval queue needs approve_content. The problem counts are for everyone.
export function registerHomeRoutes(table: RouteTable, deps: HomeRouteDeps): void {
  table.add({
    method: 'get',
    path: '/brands/:brandId/home',
    access: { kind: 'member' },
    summary: 'The home screen: results, progress, what waits for this person, and problems',
    handlers: [
      validate({ params }),
      async (_req, res) => {
        const { brandId, actor } = brandContextOf(res)
        const seesResults = Boolean(grantFor(actor, 'edit_profile'))
        const seesWaiting = Boolean(grantFor(actor, 'approve_content'))
        const now = deps.now()
        const body = await withBrand(deps.pool, brandId, async (client) => ({
          results: seesResults ? await homeResults(client, brandId, now) : null,
          progress: seesResults ? { jobs: await jobCounts(client, brandId) } : null,
          waiting: seesWaiting ? await awaitingApproval(client, brandId) : null,
          problems: await problemCounts(client, brandId),
        }))
        res.json(body)
      },
    ],
  })
}
