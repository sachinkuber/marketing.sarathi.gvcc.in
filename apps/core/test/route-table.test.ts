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
})
