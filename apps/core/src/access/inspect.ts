import type { Router } from 'express'
import { isFailSafeHandler, type RouteTable } from './routes.ts'

interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean> }
  handle?: unknown
  name?: string
}

// Every route Express holds on this router, as "GET /path".
export function registeredRoutes(router: Router): string[] {
  const layers = (router as unknown as { stack: RouterLayer[] }).stack
  const found: string[] = []
  for (const layer of layers) {
    if (!layer.route) continue
    for (const method of Object.keys(layer.route.methods))
      found.push(`${method.toUpperCase()} ${layer.route.path}`)
  }
  return found.sort()
}

// Anything on the router that nobody declared in the table: a route as "GET /path", or any other layer (a
// sub-router, a middleware mounted by mistake) as "USE <name>". The fail-safe `build` adds is not reported.
// Empty in a healthy service (acceptance test 13).
export function undeclaredRoutes(router: Router, table: RouteTable): string[] {
  const declared = new Set(table.list().map((r) => `${r.method.toUpperCase()} ${r.path}`))
  const layers = (router as unknown as { stack: RouterLayer[] }).stack
  const mounted = layers
    .filter((layer) => !layer.route && !isFailSafeHandler(layer.handle))
    .map((layer) => `USE ${layer.name || '<anonymous>'}`)
  return [...registeredRoutes(router).filter((key) => !declared.has(key)), ...mounted].sort()
}
