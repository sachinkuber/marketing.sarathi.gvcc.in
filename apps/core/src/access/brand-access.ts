import { withBrand, type Pool } from '@mkt/db'
import type { RequestHandler, Response } from 'express'
import { principalOf } from '../auth/session.ts'
import { AppError } from '../errors.ts'
import { grantFor, type Actor, type Grant, type PermissionKey } from './permissions.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface BrandContext {
  brandId: string
  actor: Actor
  grant: Grant
}

export function brandContextOf(res: Response): BrandContext {
  return res.locals.brand as BrandContext
}

// 404, not 403, for a brand the person is not in: a brand ID must not tell anyone whether the brand exists.
const NOT_FOUND = () => new AppError(404, 'not_found', 'There is nothing at this address.')

// Runs after the principal is loaded. `permission` null means any member (or the platform owner) will do.
// The role is the person's role in THIS brand, taken from the brand in the path, never from anything else.
export function brandAccess(pool: Pool, permission: PermissionKey | null): RequestHandler {
  return async (req, res, next) => {
    const brandId = req.params.brandId
    if (typeof brandId !== 'string' || !UUID.test(brandId)) throw NOT_FOUND()
    const principal = principalOf(res)
    const membership = principal.memberships.find((m) => m.brandId === brandId)
    const actor: Actor | null = principal.isPlatformOwner ? 'platform_owner' : (membership?.role ?? null)
    if (!actor) throw NOT_FOUND()
    if (principal.isPlatformOwner && !membership) {
      // The owner may open any brand that exists; one that does not looks like any other missing address.
      const found = await withBrand(pool, brandId, (client) => client.query('select 1 from app.brand'))
      if (found.rowCount === 0) throw NOT_FOUND()
    }
    const grant: Grant = permission ? grantFor(actor, permission) : 'all'
    if (!grant) throw new AppError(403, 'forbidden', 'You do not have permission to do this.')
    const context: BrandContext = { brandId, actor, grant }
    res.locals.brand = context
    next()
  }
}
