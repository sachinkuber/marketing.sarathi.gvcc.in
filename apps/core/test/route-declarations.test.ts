import { Router } from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { undeclaredRoutes } from '../src/access/inspect.ts'
import { RouteTable } from '../src/access/routes.ts'
import { createStack, type Stack } from './support.ts'

describe('every route declares the access it needs (acceptance test 13, SEC-2)', () => {
  let stack: Stack
  beforeAll(async () => {
    stack = await createStack()
  })
  afterAll(async () => stack?.close())

  it('has a declaration, with a summary, for every route the service holds', () => {
    expect(stack.core.routes.list().length).toBeGreaterThan(0)
    for (const route of stack.core.routes.list()) {
      expect(route.summary.trim(), `${route.method} ${route.path}`).not.toBe('')
      expect(route.access.kind, `${route.method} ${route.path}`).toBeDefined()
    }
    expect(undeclaredRoutes(stack.core.api, stack.core.routes)).toEqual([])
  })

  it('notices a route that was added without a declaration', () => {
    const router = Router()
    const table = new RouteTable()
    table.add({
      method: 'get',
      path: '/declared',
      access: { kind: 'public' },
      summary: 'x',
      handlers: [(_req, res) => void res.json({})],
    })
    router.get('/declared', (_req, res) => void res.json({}))
    router.post('/sneaked-in', (_req, res) => void res.json({}))
    expect(undeclaredRoutes(router, table)).toEqual(['POST /sneaked-in'])
  })

  it('reports nothing for a router built from a table, fail-safe included', () => {
    const table = new RouteTable()
    table.add({
      method: 'get',
      path: '/declared',
      access: { kind: 'public' },
      summary: 'x',
      handlers: [(_req, res) => void res.json({})],
    })
    const router = table.build({ auth: stack.core.auth, pool: stack.appPool })
    expect(undeclaredRoutes(router, table)).toEqual([])
  })

  it('notices a sub-router or middleware mounted on a built router', () => {
    const table = new RouteTable()
    table.add({
      method: 'get',
      path: '/declared',
      access: { kind: 'public' },
      summary: 'x',
      handlers: [(_req, res) => void res.json({})],
    })
    const router = table.build({ auth: stack.core.auth, pool: stack.appPool })
    router.use('/x', Router())
    router.use((_req, _res, next) => next())
    const found = undeclaredRoutes(router, table)
    expect(found).toEqual(['USE <anonymous>', 'USE router'])
  })

  it('has no public route except the ones that must be open to someone with no session', () => {
    const open = stack.core.routes
      .list()
      .filter((r) => r.access.kind === 'public')
      .map((r) => `${r.method} ${r.path}`)
      .sort()
    expect(open).toEqual(['post /invites/accept', 'post /invites/lookup'])
  })
})
