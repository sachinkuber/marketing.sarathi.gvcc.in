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

    const perm = { kind: 'permission', permission: 'manage_users' } as const

    it('refuses a path under /brands that does not continue with :brandId', () => {
      for (const path of ['/brands/:id/posts', '/brands/:brand/x', '/x/brands/y']) {
        for (const kind of plain) expect(() => declare(path, { kind })).toThrow(/must continue with :brandId/)
      }
    })

    it('refuses any other spelling of the brand parameter, as a whole segment or glued on', () => {
      for (const path of ['/brands/:brandid/x', '/x/:brandid', '/x/:BrandId', '/x/:brand_id']) {
        expect(() => declare(path, { kind: 'enrolled' })).toThrow(/spelled exactly :brandId/)
      }
      for (const path of ['/x/:brandId?', '/x/:brandId(\\d+)', '/x/y:brandId', '/x/:brandid?']) {
        expect(() => declare(path, { kind: 'enrolled' })).toThrow(/spelled exactly :brandId/)
      }
      expect(() => declare('/brands/:brandid/x', { kind: 'member' })).toThrow(/spelled exactly :brandId/)
    })

    it('refuses a brands segment that is not all lowercase (Express matches it case-insensitively)', () => {
      for (const path of ['/Brands/:id/posts', '/BRANDS/:brand/x']) {
        for (const kind of ['enrolled', 'public'] as const) {
          expect(() => declare(path, { kind })).toThrow(/lowercase/)
        }
      }
      expect(() => declare('/Brands/:brandId/x', { kind: 'member' })).toThrow(/lowercase/)
    })

    it('allows the brand routes, with or without a trailing slash', () => {
      expect(() => declare('/brands/:brandId', { kind: 'member' })).not.toThrow()
      expect(() => declare('/brands/:brandId/x', { kind: 'member' })).not.toThrow()
      for (const path of [
        '/brands/:brandId/users',
        '/brands/:brandId/users/',
        '/brands/:brandId/',
        '/brands/:brandId/users/invites',
        '/brands/:brandId/users/:userId',
      ]) {
        expect(() => declare(path, perm)).not.toThrow()
      }
    })

    it('refuses /brands/:brandId as enrolled or public, and /brands as member', () => {
      for (const kind of ['enrolled', 'public'] as const) {
        expect(() => declare('/brands/:brandId', { kind })).toThrow(/member or a permission/)
      }
      expect(() => declare('/brands', { kind: 'member' })).toThrow(/under \/brands\/:brandId/)
    })

    it('allows the list route and the other routes the service has', () => {
      expect(() => declare('/brands', { kind: 'enrolled' })).not.toThrow()
      expect(() => declare('/users/:userId/second-factor/reset', { kind: 'platform_owner' })).not.toThrow()
      expect(() => declare('/session', { kind: 'signed_in' })).not.toThrow()
      expect(() => declare('/invites/lookup', { kind: 'public' })).not.toThrow()
      expect(() => declare('/invites/accept', { kind: 'public' })).not.toThrow()
    })

    it('requires the brand check to start the path', () => {
      expect(() => declare('/things/brands/:brandId/x', { kind: 'member' })).toThrow(
        /must continue|under \/brands/,
      )
      expect(() => declare('/x/:brandId', { kind: 'enrolled' })).toThrow(/member or a permission/)
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
