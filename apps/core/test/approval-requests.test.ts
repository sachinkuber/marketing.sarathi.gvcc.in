import { withBrand } from '@mkt/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { tick } from '../src/approvals/requests.ts'
import { createVersion, moveState } from '../src/content/versions.ts'
import { ManualClock } from '../src/notify/doubles.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
const H = 3_600_000
const DAY = 24 * H

let stack: Stack
let clock: ManualClock
let seq = 0
let ownerClient: TestClient

const deps = () => ({ clock, audit: stack.audit })
const runTick = () => tick(stack.appPool, deps())
const at = (hours: number, from: Date) => new Date(from.getTime() + hours * H)

interface Setup {
  brandId: string
  approverId: string
  adminId: string
  admin: TestClient
  approver: TestClient
}

// A brand with one approver and one brand admin, both signed in.
async function makeBrand(): Promise<Setup> {
  seq += 1
  const brandId = await addBrand(stack, `req-${seq}`)
  const approverId = await addUser(stack, {
    email: `ap${seq}@example.test`,
    password: PASSWORD,
    role: 'approver',
    brandId,
  })
  const adminId = await addUser(stack, {
    email: `ad${seq}@example.test`,
    password: PASSWORD,
    role: 'brand_admin',
    brandId,
  })
  return {
    brandId,
    approverId,
    adminId,
    admin: (await enrolledClient(stack, `ad${seq}@example.test`, PASSWORD)).client,
    approver: (await enrolledClient(stack, `ap${seq}@example.test`, PASSWORD)).client,
  }
}

// An item with one version waiting for approval, its request opened "now" by the controlled clock.
async function waiting(brandId: string): Promise<{ versionId: string; requestId: string; openedAt: Date }> {
  const item = (
    await stack.db.admin.query(
      `insert into app.content_item (brand_id, kind) values ($1, 'article') returning id`,
      [brandId],
    )
  ).rows[0].id as string
  const actor = { kind: 'system' as const }
  const created = await withBrand(stack.appPool, brandId, async (client) => {
    const v = await createVersion(client, deps(), {
      brandId,
      contentItemId: item,
      payload: {
        kind: 'article' as const,
        language: 'en',
        title: 'T',
        body: [{ type: 'paragraph' as const, text: `Hello ${seq}` }],
      },
      createdBy: actor,
    })
    await moveState(client, deps(), v.versionId, 'in_checks', actor)
    await moveState(client, deps(), v.versionId, 'awaiting_approval', actor)
    return v
  })
  const openedAt = clock.now()
  const req = await stack.db.admin.query(
    'update app.approval_request set requested_at = $2 where content_version_id = $1 returning id',
    [created.versionId, openedAt],
  )
  return { versionId: created.versionId, requestId: req.rows[0].id as string, openedAt }
}

const requestRow = async (id: string) =>
  (await stack.db.admin.query('select * from app.approval_request where id = $1', [id])).rows[0]
const notified = async (versionId: string, kind: string) =>
  (
    await stack.db.admin.query(
      'select user_id from app.notification where subject_id = $1 and kind = $2 order by created_at, id',
      [versionId, kind],
    )
  ).rows.map((r) => r.user_id as string)
const auditActions = (versionId: string) =>
  stack.audit.entries.filter((e) => e.subject === versionId).map((e) => e.action)

beforeAll(async () => {
  clock = new ManualClock(new Date('2026-03-02T09:00:00Z'))
  stack = await createStack({ withQueue: true, clock })
  await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
  ownerClient = (await enrolledClient(stack, 'owner@example.test', PASSWORD)).client
})
afterEach(async () => {
  // Each test starts with no other open request, so one test's ticks never count another's.
  await stack.db.admin.query('update app.approval_request set closed_at = now() where closed_at is null')
})
afterAll(async () => {
  await stack?.close()
})

describe('reminders and escalation (test 20)', () => {
  it('reminds the approvers at 24, 48 and 72 hours and no more, then marks overdue and escalates at 96', async () => {
    const b = await makeBrand()
    const w = await waiting(b.brandId)
    const sentAt: number[] = []
    let overdueAt: number | null = null
    for (let h = 1; h <= 100; h += 1) {
      clock.advance(H)
      const out = await runTick()
      if (out.reminded > 0) sentAt.push(h)
      if (out.overdue > 0) overdueAt = h
      // Nothing is overdue before the gap after the last reminder has passed.
      if (h < 96) expect((await requestRow(w.requestId)).overdue).toBe(false)
    }
    expect(sentAt).toEqual([24, 48, 72])
    expect(overdueAt).toBe(96)
    expect(await notified(w.versionId, 'approval_reminder')).toEqual([
      b.approverId,
      b.approverId,
      b.approverId,
    ])
    const row = await requestRow(w.requestId)
    expect(row.reminders_sent).toBe(3)
    expect(row.overdue).toBe(true)
    expect(row.escalated_to).toBe(b.adminId)
    expect(row.escalated_at).toEqual(at(96, w.openedAt))
    expect(await notified(w.versionId, 'approval_overdue')).toEqual([b.adminId])
    expect(auditActions(w.versionId)).toEqual(
      expect.arrayContaining(['approval.overdue', 'approval.escalated']),
    )
  })

  it('escalates to the platform owner one gap after the brand admin, and then stops', async () => {
    const b = await makeBrand()
    const w = await waiting(b.brandId)
    clock.advance(96 * H)
    // Late ticks catch up one reminder each; the gap to overdue then starts from the last of them.
    for (let i = 0; i < 3; i += 1) {
      expect((await runTick()).reminded).toBe(1)
      clock.advance(DAY)
    }
    expect(await runTick()).toEqual({ failedBrands: 0, reminded: 0, overdue: 1, escalated: 1 })
    const afterAdmin = await requestRow(w.requestId)
    expect(afterAdmin.escalated_to).toBe(b.adminId)
    clock.advance(DAY)
    const out = await runTick()
    expect(out).toEqual({ failedBrands: 0, reminded: 0, overdue: 0, escalated: 1 })
    const owner = (
      await stack.db.admin.query(`select u.id from auth."user" u where u.email = 'owner@example.test'`)
    ).rows[0].id as string
    const row = await requestRow(w.requestId)
    expect(row.escalated_to).toBe(owner)
    expect(await notified(w.versionId, 'approval_overdue')).toEqual([b.adminId, owner])
    clock.advance(30 * DAY)
    expect(await runTick()).toEqual({ failedBrands: 0, reminded: 0, overdue: 0, escalated: 0 })
  })

  it('marks overdue only, with no escalation, when the only approver is a platform owner', async () => {
    const b = await makeBrand()
    const owner = (
      await stack.db.admin.query(`select id from auth."user" where email = 'owner@example.test'`)
    ).rows[0].id as string
    await stack.db.admin.query('delete from app.membership where brand_id = $1 and role = $2', [
      b.brandId,
      'approver',
    ])
    await stack.db.admin.query(
      `insert into app.membership (brand_id, user_id, role) values ($1, $2, 'approver')`,
      [b.brandId, owner],
    )
    const w = await waiting(b.brandId)
    for (let i = 0; i < 5; i += 1) {
      clock.advance(DAY)
      await runTick()
    }
    clock.advance(30 * DAY)
    await runTick()
    const row = await requestRow(w.requestId)
    expect(row.overdue).toBe(true)
    expect(row.escalated_to).toBeNull()
    expect(row.escalated_at).toBeNull()
    expect(await notified(w.versionId, 'approval_overdue')).toEqual([])
    expect(auditActions(w.versionId)).toContain('approval.overdue')
    expect(auditActions(w.versionId)).not.toContain('approval.escalated')
  })
})

describe('silence is not approval (test 21)', () => {
  it('creates no approval, no outbox action and no state change in 30 days of ticks', async () => {
    const b = await makeBrand()
    const w = await waiting(b.brandId)
    const before = await stack.db.admin.query(
      `select (select count(*)::int from app.approval) as approvals,
              (select count(*)::int from app.outbox_action) as outbox,
              (select count(*)::int from app.content_version_state_change) as changes`,
    )
    for (let i = 0; i < 30 * 4; i += 1) {
      clock.advance(6 * H)
      await runTick()
    }
    const after = await stack.db.admin.query(
      `select (select count(*)::int from app.approval) as approvals,
              (select count(*)::int from app.outbox_action) as outbox,
              (select count(*)::int from app.content_version_state_change) as changes`,
    )
    expect(after.rows[0]).toEqual(before.rows[0])
    const state = await stack.db.admin.query(
      'select state from app.content_version_state where content_version_id = $1',
      [w.versionId],
    )
    expect(state.rows[0].state).toBe('awaiting_approval')
    const row = await requestRow(w.requestId)
    expect(row.overdue).toBe(true)
    expect(row.closed_at).toBeNull()
  })

  it('stops reminding a request that has been decided', async () => {
    const b = await makeBrand()
    const w = await waiting(b.brandId)
    await stack.db.admin.query('update app.approval_request set closed_at = $2 where id = $1', [
      w.requestId,
      clock.now(),
    ])
    clock.advance(10 * DAY)
    expect(await runTick()).toEqual({ failedBrands: 0, reminded: 0, overdue: 0, escalated: 0 })
  })
})

describe('idempotence', () => {
  it('sends nothing extra when ticked ten times at the same instant', async () => {
    const b = await makeBrand()
    const w = await waiting(b.brandId)
    clock.advance(24 * H)
    const totals = { reminded: 0, overdue: 0, escalated: 0 }
    for (let i = 0; i < 10; i += 1) {
      const out = await runTick()
      totals.reminded += out.reminded
    }
    expect(totals.reminded).toBe(1)
    expect(await notified(w.versionId, 'approval_reminder')).toHaveLength(1)
  })

  it('does not double-send when two ticks overlap', async () => {
    const b = await makeBrand()
    const w = await waiting(b.brandId)
    clock.advance(24 * H)
    const results = await Promise.all([runTick(), runTick(), runTick()])
    expect(results.reduce((n, r) => n + r.reminded, 0)).toBe(1)
    expect((await requestRow(w.requestId)).reminders_sent).toBe(1)
    expect(await notified(w.versionId, 'approval_reminder')).toHaveLength(1)
  })

  it('keeps reminders one gap apart after a long outage, not back to back', async () => {
    const b = await makeBrand()
    const w = await waiting(b.brandId)
    clock.advance(10 * DAY)
    expect((await runTick()).reminded).toBe(1)
    expect((await runTick()).reminded).toBe(0)
    clock.advance(60_000)
    expect((await runTick()).reminded).toBe(0)
    clock.advance(DAY - 60_000)
    expect((await runTick()).reminded).toBe(1)
    expect((await requestRow(w.requestId)).reminders_sent).toBe(2)
    expect(await notified(w.versionId, 'approval_reminder')).toHaveLength(2)
  })
})

describe('one failing brand', () => {
  it('is rolled back, counted and logged by name, and the other brands still get their reminders', async () => {
    const bad = await makeBrand()
    const good = await makeBrand()
    const wBad = await waiting(bad.brandId)
    const wGood = await waiting(good.brandId)
    await stack.db.admin.query(`
      create function app.test_fail_notification() returns trigger language plpgsql as $$
      begin
        if new.brand_id = '${bad.brandId}' then raise exception 'boom secret-detail'; end if;
        return new;
      end $$`)
    await stack.db.admin.query(
      'create trigger test_fail before insert on app.notification for each row execute function app.test_fail_notification()',
    )
    const logged: unknown[] = []
    const logger = { warn: () => undefined, error: (o: unknown) => void logged.push(o) }
    try {
      clock.advance(24 * H)
      const out = await tick(stack.appPool, { clock, audit: stack.audit, logger })
      expect(out).toEqual({ failedBrands: 1, reminded: 1, overdue: 0, escalated: 0 })
    } finally {
      await stack.db.admin.query('drop trigger test_fail on app.notification')
      await stack.db.admin.query('drop function app.test_fail_notification()')
    }
    expect(await notified(wGood.versionId, 'approval_reminder')).toEqual([good.approverId])
    expect(await notified(wBad.versionId, 'approval_reminder')).toEqual([])
    expect((await requestRow(wBad.requestId)).reminders_sent).toBe(0)
    expect(logged).toHaveLength(1)
    expect(JSON.stringify(logged)).not.toContain('secret-detail')
    expect(logged[0]).toMatchObject({ brand: bad.brandId })
    // Once the fault is gone the brand catches up on the next tick.
    expect((await runTick()).reminded).toBe(1)
  })
})

describe('approval settings (test 23)', () => {
  const settingsPath = (brandId: string) => `/api/v1/brands/${brandId}/approval-settings`

  it('lowering the count from 3 to 2 means the third reminder never goes', async () => {
    const b = await makeBrand()
    const w = await waiting(b.brandId)
    clock.advance(24 * H)
    expect((await runTick()).reminded).toBe(1)
    const patched = await b.admin.request('PATCH', settingsPath(b.brandId), { body: { reminderCount: 2 } })
    expect(patched.status).toBe(200)
    expect(patched.json).toEqual({
      firstReminderAfterMinutes: 1440,
      reminderGapMinutes: 1440,
      reminderCount: 2,
    })
    clock.advance(24 * H)
    expect((await runTick()).reminded).toBe(1)
    clock.advance(24 * H)
    // No third reminder: the request is overdue one gap after the second instead.
    expect(await runTick()).toEqual({ failedBrands: 0, reminded: 0, overdue: 1, escalated: 1 })
    expect((await requestRow(w.requestId)).reminders_sent).toBe(2)
    expect(await notified(w.versionId, 'approval_reminder')).toHaveLength(2)
  })

  it('changing the timing moves the next reminder of an open request', async () => {
    const b = await makeBrand()
    const w = await waiting(b.brandId)
    const owner = ownerClient
    const patched = await owner.request('PATCH', settingsPath(b.brandId), {
      body: { firstReminderAfterMinutes: 48 * 60 },
    })
    expect(patched.status).toBe(200)
    clock.advance(24 * H)
    expect((await runTick()).reminded).toBe(0)
    clock.advance(24 * H)
    expect((await runTick()).reminded).toBe(1)
    // A shorter gap brings the next one forward.
    await b.admin.request('PATCH', settingsPath(b.brandId), { body: { reminderGapMinutes: 60 } })
    clock.advance(H)
    expect((await runTick()).reminded).toBe(1)
    expect((await requestRow(w.requestId)).reminders_sent).toBe(2)
    expect(
      stack.audit.entries.filter((e) => e.action === 'approval_settings.updated' && e.brandId === b.brandId),
    ).toHaveLength(2)
  })

  it('lets the owner and a brand admin read and change, and refuses an approver and bad values', async () => {
    const b = await makeBrand()
    const owner = ownerClient
    expect((await b.admin.request('GET', settingsPath(b.brandId))).json).toEqual({
      firstReminderAfterMinutes: 1440,
      reminderGapMinutes: 1440,
      reminderCount: 3,
    })
    expect(
      (await owner.request('PATCH', settingsPath(b.brandId), { body: { reminderCount: 5 } })).status,
    ).toBe(200)
    expect(
      (await b.admin.request('PATCH', settingsPath(b.brandId), { body: { reminderCount: 4 } })).status,
    ).toBe(200)
    const denied = await b.approver.request('PATCH', settingsPath(b.brandId), { body: { reminderCount: 1 } })
    expect(denied.status).toBe(403)
    expect((await b.approver.request('GET', settingsPath(b.brandId))).status).toBe(403)
    expect((await b.admin.request('GET', settingsPath(b.brandId))).json.reminderCount).toBe(4)
    for (const body of [
      { reminderCount: 0 },
      { reminderCount: 6 },
      { reminderCount: 2.5 },
      { reminderGapMinutes: 0 },
      { firstReminderAfterMinutes: -5 },
      { unknown: 1 },
      {},
    ]) {
      expect((await b.admin.request('PATCH', settingsPath(b.brandId), { body })).status).toBe(400)
    }
    // Another brand's admin cannot see or change this brand's settings.
    const other = await makeBrand()
    expect(
      (await other.admin.request('PATCH', settingsPath(b.brandId), { body: { reminderCount: 1 } })).status,
    ).toBe(404)
  })
})

describe('worker route', () => {
  it('ticks with the injected clock and answers with counts only', async () => {
    const b = await makeBrand()
    const w = await waiting(b.brandId)
    clock.advance(24 * H)
    const headers = {
      authorization: `Worker ${stack.jobs!.workerSecret}`,
      'content-type': 'application/json',
    }
    const res = await fetch(`${stack.server.url}/api/v1/worker/approvals/tick`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ failedBrands: 0, reminded: 1, overdue: 0, escalated: 0 })
    expect(await notified(w.versionId, 'approval_reminder')).toHaveLength(1)
    const anonymous = await fetch(`${stack.server.url}/api/v1/worker/approvals/tick`, { method: 'POST' })
    expect(anonymous.status).toBeGreaterThanOrEqual(401)
  })
})
