import type { RequestHandler } from 'express'
import { describe, expect, it } from 'vitest'
import { RouteTable } from '../src/access/routes.ts'

const ok: RequestHandler = (_req, res) => {
  res.json({ ok: true })
}

describe('RouteTable', () => {
  it('refuses a brand-scoped route that is not under /brands/:brandId', () => {
    const table = new RouteTable()
    expect(() =>
      table.add({ method: 'get', path: '/things', access: { kind: 'member' }, summary: 'x', handlers: [ok] }),
    ).toThrow(/under \/brands\/:brandId/)
    expect(() =>
      table.add({
        method: 'get',
        path: '/things',
        access: { kind: 'permission', permission: 'manage_users' },
        summary: 'x',
        handlers: [ok],
      }),
    ).toThrow(/under \/brands\/:brandId/)
  })

  it('refuses a /brands/:brandId route declared as anything but member or a permission', () => {
    const table = new RouteTable()
    for (const kind of ['public', 'signed_in', 'enrolled', 'platform_owner'] as const) {
      expect(() =>
        table.add({
          method: 'get',
          path: '/brands/:brandId/x',
          access: { kind },
          summary: 'x',
          handlers: [ok],
        }),
      ).toThrow(/member or a permission/)
    }
  })

  it('refuses a route declared twice, and a route with no handler or no summary', () => {
    const table = new RouteTable()
    const route = {
      method: 'get',
      path: '/a',
      access: { kind: 'public' },
      summary: 'a',
      handlers: [ok],
    } as const
    table.add({ ...route, handlers: [ok] })
    expect(() => table.add({ ...route, handlers: [ok] })).toThrow(/declared twice/)
    expect(() => table.add({ ...route, path: '/b', handlers: [] })).toThrow(/no handler/)
    expect(() => table.add({ ...route, path: '/c', summary: '  ' })).toThrow(/summary/)
  })

  it('lists what was declared', () => {
    const table = new RouteTable()
    table.add({ method: 'post', path: '/a', access: { kind: 'public' }, summary: 'a', handlers: [ok] })
    expect(table.list().map((r) => `${r.method} ${r.path}`)).toEqual(['post /a'])
  })

  describe('decides brand scope by path segment, not by substring', () => {
    type Kind = 'public' | 'signed_in' | 'enrolled' | 'platform_owner'
    const plain: Kind[] = ['public', 'signed_in', 'enrolled', 'platform_owner']
    const declare = (path: string, access: Parameters<RouteTable['add']>[0]['access']) =>
      new RouteTable().add({ method: 'get', path, access, summary: 'x', handlers: [ok] })

    it('refuses a brand parameter spelled any way but :brandId under /brands', () => {
      for (const path of ['/brands/:id/posts', '/brands/:brandid/x', '/brands/:brand/x']) {
        for (const kind of plain) expect(() => declare(path, { kind })).toThrow()
      }
    })

    it('allows /brands/:brandId/... as member or a permission', () => {
      expect(() => declare('/brands/:brandId/x', { kind: 'member' })).not.toThrow()
      expect(() =>
        declare('/brands/:brandId/x', { kind: 'permission', permission: 'manage_users' }),
      ).not.toThrow()
      expect(() =>
        declare('/brands/:brandId/users/:userId', { kind: 'permission', permission: 'manage_users' }),
      ).not.toThrow()
    })

    it('allows the list route /brands as enrolled, but not as member', () => {
      expect(() => declare('/brands', { kind: 'enrolled' })).not.toThrow()
      expect(() => declare('/brands', { kind: 'member' })).toThrow()
    })

    it('requires the brand check to start the path', () => {
      expect(() => declare('/things/brands/:brandId/x', { kind: 'member' })).toThrow()
    })

    it('refuses any other spelling of the brand parameter anywhere', () => {
      for (const path of ['/x/:brandid', '/x/:BrandId', '/x/:brand_id', '/x/:brandId']) {
        expect(() => declare(path, { kind: 'enrolled' })).toThrow()
      }
    })

    it('keeps its own copy of the handlers', () => {
      const table = new RouteTable()
      const handlers = [ok]
      table.add({ method: 'get', path: '/a', access: { kind: 'public' }, summary: 'a', handlers })
      handlers.length = 0
      expect(table.list()[0]?.handlers).toHaveLength(1)
    })
  })
})
