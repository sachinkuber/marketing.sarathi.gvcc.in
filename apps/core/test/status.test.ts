import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, cast, readsStack, statuses, type Cast } from './reads-support.ts'
import type { Stack } from './support.ts'

let stack: Stack
let c: Cast

beforeAll(async () => {
  stack = await readsStack()
  c = await cast(stack)
})
afterAll(async () => stack?.close())

describe('GET /brands/:brandId/status', () => {
  it('answers every member and the owner, and 404 to a stranger', async () => {
    expect(await statuses(c, 'GET', api(c.brandId, '/status'))).toEqual([200, 200, 200, 200, 404])
  })

  it('says what the banner needs, per role', async () => {
    const quiet = (await c.admin.request('GET', api(c.brandId, '/status'))).json
    expect(quiet).toEqual({
      killSwitch: { active: false, scopes: [] },
      shadowMode: false,
      canApprove: true,
      canStop: true,
    })
    expect((await c.approver.request('GET', api(c.brandId, '/status'))).json).toMatchObject({
      canApprove: true,
      canStop: false,
    })
    expect((await c.viewer.request('GET', api(c.brandId, '/status'))).json).toMatchObject({
      canApprove: false,
      canStop: false,
    })
  })

  it('lists the active switches and the shadow flag, and nothing of another brand', async () => {
    const other = await cast(stack)
    await stack.db.admin.query(
      `insert into app.kill_switch (brand_id, scope, target, active, set_by) values ($1, 'agent', 'summary', true, $2)`,
      [c.brandId, c.adminId],
    )
    await stack.db.admin.query(`update app.brand set shadow_mode = true where id = $1`, [c.brandId])
    const reply = await c.viewer.request('GET', api(c.brandId, '/status'))
    expect(reply.json.killSwitch).toEqual({ active: true, scopes: [{ scope: 'agent', target: 'summary' }] })
    expect(reply.json.shadowMode).toBe(true)
    const theirs = await other.admin.request('GET', api(other.brandId, '/status'))
    expect(theirs.json.killSwitch).toEqual({ active: false, scopes: [] })
    expect(theirs.json.shadowMode).toBe(false)
  })
})
