import type { Pool } from '@mkt/db'
import { fromNodeHeaders } from 'better-auth/node'
import type { RequestHandler, Response } from 'express'
import { AppError } from '../errors.ts'
import type { Auth } from './options.ts'

export type Role = 'brand_admin' | 'approver' | 'sales_contact' | 'viewer'

export interface Principal {
  userId: string
  sessionId: string
  email: string
  name: string
  twoFactorEnabled: boolean
  isPlatformOwner: boolean
  memberships: { brandId: string; role: Role }[]
  needsSecondFactor: boolean
}

// SEC-1. Only a user whose every membership is Viewer is exempt. No memberships, or any other role,
// or being a platform owner, means a second factor is required.
export function needsSecondFactor(isPlatformOwner: boolean, memberships: { role: Role }[]): boolean {
  if (isPlatformOwner) return true
  if (memberships.length === 0) return true
  return memberships.some((membership) => membership.role !== 'viewer')
}

export function loadPrincipal(auth: Auth, pool: Pool): RequestHandler {
  return async (req, res, next) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) throw new AppError(401, 'not_signed_in', 'Sign in to continue.')
    const userId = session.user.id
    // No brand is set yet, so these two named functions read across brands for this one user.
    const owner = await pool.query('select app.is_platform_owner($1) as owner', [userId])
    const rows = await pool.query('select brand_id, role from app.memberships_for_user($1)', [userId])
    const memberships = rows.rows.map((row) => ({ brandId: row.brand_id as string, role: row.role as Role }))
    const isPlatformOwner = Boolean(owner.rows[0]?.owner)
    const principal: Principal = {
      userId,
      sessionId: session.session.id,
      email: session.user.email,
      name: session.user.name,
      twoFactorEnabled: Boolean((session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled),
      isPlatformOwner,
      memberships,
      needsSecondFactor: needsSecondFactor(isPlatformOwner, memberships),
    }
    res.locals.principal = principal
    next()
  }
}

export function principalOf(res: Response): Principal {
  return res.locals.principal as Principal
}

// Until a second factor is set, only the enrolment routes (the library's, under /api/auth) work.
export const enrolmentGate: RequestHandler = (_req, res, next) => {
  const principal = principalOf(res)
  if (principal.needsSecondFactor && !principal.twoFactorEnabled) {
    throw new AppError(403, 'enrolment_required', 'Set up a second factor first.')
  }
  next()
}
