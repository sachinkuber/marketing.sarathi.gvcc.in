import { withBrand, type Pool } from '@mkt/db'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { principalOf } from '../auth/session.ts'
import { AppError } from '../errors.ts'
import { validate } from '../validate.ts'

interface BrandRow {
  id: string
  name: string
  slug: string
  status: string
  shadowMode: boolean
}

// Row-level security shows only the brand that was set, so this can never return another brand's row; the
// id is named in the query as well, so that stays true even if the policy were ever wrong.
async function readBrand(pool: Pool, brandId: string): Promise<BrandRow | null> {
  return withBrand(pool, brandId, async (client) => {
    const result = await client.query(
      'select id, name, slug, status, shadow_mode from app.brand where id = $1',
      [brandId],
    )
    const row = result.rows[0]
    return row
      ? { id: row.id, name: row.name, slug: row.slug, status: row.status, shadowMode: row.shadow_mode }
      : null
  })
}

export function registerBrandRoutes(table: RouteTable, deps: { pool: Pool }): void {
  table.add({
    method: 'get',
    path: '/brands',
    access: { kind: 'enrolled' },
    summary: 'The brands the signed-in person belongs to',
    handlers: [
      async (_req, res) => {
        const brands = []
        for (const membership of principalOf(res).memberships) {
          const row = await readBrand(deps.pool, membership.brandId)
          if (row)
            brands.push({
              id: row.id,
              name: row.name,
              slug: row.slug,
              status: row.status,
              role: membership.role,
            })
        }
        res.json({ brands })
      },
    ],
  })

  table.add({
    method: 'get',
    path: '/brands/:brandId',
    access: { kind: 'member' },
    summary: 'One brand, with the signed-in person’s role in it',
    handlers: [
      validate({ params: z.strictObject({ brandId: z.uuid() }) }),
      async (_req, res) => {
        const context = brandContextOf(res)
        const row = await readBrand(deps.pool, context.brandId)
        if (!row) throw new AppError(404, 'not_found', 'There is nothing at this address.')
        res.json({ ...row, role: context.actor })
      },
    ],
  })
}
