import { withBrand, type Pool } from '@mkt/db'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { grantFor } from '../access/permissions.ts'
import { principalOf, type Principal } from '../auth/session.ts'
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

export interface VisibleBrand {
  id: string
  name: string
  slug: string
  status: string
  role: string
}

// The brands a person can open. Someone who holds see_other_brands (the platform owner) sees every brand,
// each with the role platform_owner, read through a definer function that answers only for a platform owner.
// Everyone else sees exactly the brands they have a membership in, with that role.
export async function visibleBrands(pool: Pool, principal: Principal): Promise<VisibleBrand[]> {
  const seesAll =
    (principal.isPlatformOwner && grantFor('platform_owner', 'see_other_brands')) ||
    principal.memberships.some((m) => grantFor(m.role, 'see_other_brands'))
  if (seesAll) {
    const all = await pool.query(
      'select id, name, slug, status from app.brands_for_platform_owner($1) order by slug, id',
      [principal.userId],
    )
    return all.rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      slug: row.slug as string,
      status: row.status as string,
      role: 'platform_owner',
    }))
  }
  const brands: VisibleBrand[] = []
  for (const membership of principal.memberships) {
    const row = await readBrand(pool, membership.brandId)
    if (row)
      brands.push({
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
        role: membership.role,
      })
  }
  return brands
}

export function registerBrandRoutes(table: RouteTable, deps: { pool: Pool }): void {
  table.add({
    method: 'get',
    path: '/brands',
    access: { kind: 'enrolled' },
    summary:
      'The brands the signed-in person can open: their memberships, or every brand for the platform owner',
    handlers: [
      async (_req, res) => {
        res.json({ brands: await visibleBrands(deps.pool, principalOf(res)) })
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
