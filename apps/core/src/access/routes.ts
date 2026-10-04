import type { Pool } from '@mkt/db'
import { Router, type RequestHandler } from 'express'
import type { Auth } from '../auth/options.ts'
import { enrolmentGate, loadPrincipal, principalOf } from '../auth/session.ts'
import { AppError } from '../errors.ts'
import { brandAccess } from './brand-access.ts'
import type { PermissionKey } from './permissions.ts'

// What a route needs. Every route says so; there is no default.
export type Access =
  | { kind: 'public' }
  | { kind: 'signed_in' }
  | { kind: 'enrolled' }
  | { kind: 'platform_owner' }
  | { kind: 'member' }
  | { kind: 'permission'; permission: PermissionKey }

export type Method = 'get' | 'post' | 'patch' | 'delete'

export interface RouteDeclaration {
  method: Method
  path: string
  access: Access
  summary: string
  handlers: readonly RequestHandler[]
}

const requirePlatformOwner: RequestHandler = (_req, res, next) => {
  if (!principalOf(res).isPlatformOwner) {
    throw new AppError(403, 'forbidden', 'You do not have permission to do this.')
  }
  next()
}

// The only way a route reaches the service. Nothing else holds the router, so a route without a declaration
// cannot exist (SEC-2), and a brand-scoped route cannot be written without the brand check.
export class RouteTable {
  private readonly routes: RouteDeclaration[] = []

  add(route: RouteDeclaration): void {
    const where = `${route.method} ${route.path}`
    const segments = route.path.split('/').filter((segment) => segment !== '')
    const brandScoped = route.access.kind === 'member' || route.access.kind === 'permission'
    // Decided by path segment, never by substring: a misspelt parameter must not slip past the brand check.
    for (const segment of segments) {
      // Any spelling of the brand parameter, bare or with a modifier, a pattern or text glued on, but :brandId.
      if (/brand_?id/i.test(segment) && segment !== ':brandId') {
        throw new Error(`${where}: the brand parameter must be spelled exactly :brandId`)
      }
      // Express matches paths case-insensitively, so /Brands/... would serve /brands/... unchecked.
      if (segment.toLowerCase() === 'brands' && segment !== 'brands') {
        throw new Error(`${where}: the brands segment must be spelled in lowercase`)
      }
    }
    const underBrand = segments[0] === 'brands' && segments[1] === ':brandId'
    const brandsAt = segments.indexOf('brands')
    const brandsHasChild = brandsAt >= 0 && brandsAt < segments.length - 1
    if (brandsHasChild && segments[brandsAt + 1] !== ':brandId') {
      throw new Error(`${where}: a path under /brands must continue with :brandId`)
    }
    if (brandScoped && !underBrand) {
      throw new Error(`${where}: a member or permission route must live under /brands/:brandId`)
    }
    if (!brandScoped && (underBrand || segments.includes(':brandId') || brandsHasChild)) {
      throw new Error(`${where}: a route with :brandId must be declared as member or a permission`)
    }
    if (route.handlers.length === 0) throw new Error(`${where}: no handler`)
    if (route.summary.trim() === '') throw new Error(`${where}: a summary is required`)
    if (this.routes.some((r) => r.method === route.method && r.path === route.path)) {
      throw new Error(`${where}: declared twice`)
    }
    this.routes.push({ ...route, handlers: [...route.handlers] })
  }

  list(): readonly RouteDeclaration[] {
    return this.routes
  }

  build(deps: { auth: Auth; pool: Pool }): Router {
    const router = Router()
    const principal = loadPrincipal(deps.auth, deps.pool)
    for (const route of this.routes) {
      const chain: RequestHandler[] = []
      switch (route.access.kind) {
        case 'public':
          break
        case 'signed_in':
          chain.push(principal)
          break
        case 'enrolled':
          chain.push(principal, enrolmentGate)
          break
        case 'platform_owner':
          chain.push(principal, enrolmentGate, requirePlatformOwner)
          break
        case 'member':
          chain.push(principal, enrolmentGate, brandAccess(deps.pool, null))
          break
        case 'permission':
          chain.push(principal, enrolmentGate, brandAccess(deps.pool, route.access.permission))
          break
      }
      router[route.method](route.path, ...chain, ...route.handlers)
    }
    // Fail safe: anything registered on this router after it was built (a test's probe, a mistake) is
    // still behind a session and a finished enrolment.
    router.use(principal, enrolmentGate)
    return router
  }
}
