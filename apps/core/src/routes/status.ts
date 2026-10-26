import { withBrand, type Pool } from '@mkt/db'
import { z } from 'zod'
import { grantFor } from '../access/permissions.ts'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { validate } from '../validate.ts'

const params = z.strictObject({ brandId: z.uuid() })

export function registerStatusRoutes(table: RouteTable, deps: { pool: Pool }): void {
  table.add({
    method: 'get',
    path: '/brands/:brandId/status',
    access: { kind: 'member' },
    summary: 'What the banner shows: active kill switches, shadow mode and what this person can do',
    handlers: [
      validate({ params }),
      async (_req, res) => {
        const { brandId, actor } = brandContextOf(res)
        const { switches, shadow } = await withBrand(deps.pool, brandId, async (client) => {
          const found = await client.query<{ scope: string; target: string | null }>(
            `select scope, target from app.kill_switch where brand_id = $1 and active order by set_at, id`,
            [brandId],
          )
          const brand = await client.query<{ shadow_mode: boolean }>(
            'select shadow_mode from app.brand where id = $1',
            [brandId],
          )
          return { switches: found.rows, shadow: brand.rows[0]?.shadow_mode ?? false }
        })
        res.json({
          killSwitch: { active: switches.length > 0, scopes: switches },
          shadowMode: shadow,
          canApprove: Boolean(grantFor(actor, 'approve_content')),
          canStop: Boolean(grantFor(actor, 'use_kill_switch')),
        })
      },
    ],
  })
}
