import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  auditMismatchHandler,
  alertOnOperationalFindings,
  raiseAlert,
  retryAlerts,
} from '../src/notify/alerts.ts'
import { DoubleAlertChannel, DoubleMailer, ManualClock } from '../src/notify/doubles.ts'
import { deliverPending, enqueueNotification, notificationBackoffMs } from '../src/notify/notifications.ts'
import type { NotifyDeps } from '../src/notify/ports.ts'
import { approversOf, brandAdminsOf, emailOf, platformOwnersOf } from '../src/notify/recipients.ts'
import { runNotifyTick } from '../src/notify/tick.ts'
import { createJob, createRun } from '../src/jobs/service.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
const OWNER_1 = 'owner1@example.test'
const OWNER_2 = 'owner2@example.test'
const RECIPIENT = 'person@example.test'

let stack: Stack
let mailer: DoubleMailer
let channel: DoubleAlertChannel
let clock: ManualClock
let start: Date
let deps: NotifyDeps
let logged: string[]
let brandA: string
let brandB: string
let recipientId: string
let owner: TestClient
let approver: TestClient
let viewer: TestClient
let bApprover: TestClient

const alertRows = async (where = 'true') =>
  (await stack.db.admin.query(`select * from app.alert where ${where} order by raised_at, id`)).rows
const notificationRow = async (id: string) =>
  (await stack.db.admin.query('select * from app.notification where id = $1', [id])).rows[0]
const enqueue = (brandId = brandA) =>
  withBrand(stack.appPool, brandId, (client) =>
    enqueueNotification(client, {
      brandId,
      userId: recipientId,
      kind: 'approval_waiting',
      subject: { kind: 'content_version', id: '5f1b8b1e-3c0d-4f8e-9a56-7a1c2f0e9d11' },
    }),
  )

beforeAll(async () => {
  stack = await createStack({ withQueue: true })
  brandA = await addBrand(stack, 'notify-a')
  brandB = await addBrand(stack, 'notify-b')
  await addUser(stack, { email: OWNER_1, password: PASSWORD, platformOwner: true })
  await addUser(stack, { email: OWNER_2, password: PASSWORD, platformOwner: true })
  recipientId = await addUser(stack, {
    email: RECIPIENT,
    password: PASSWORD,
    role: 'approver',
    brandId: brandA,
  })
  await addUser(stack, {
    email: 'admin@example.test',
    password: PASSWORD,
    role: 'brand_admin',
    brandId: brandA,
  })
  await addUser(stack, { email: 'ap@example.test', password: PASSWORD, role: 'approver', brandId: brandA })
  await addUser(stack, { email: 'vw@example.test', password: PASSWORD, role: 'viewer', brandId: brandA })
  await addUser(stack, { email: 'bap@example.test', password: PASSWORD, role: 'approver', brandId: brandB })
  owner = (await enrolledClient(stack, OWNER_1, PASSWORD)).client
  approver = (await enrolledClient(stack, 'ap@example.test', PASSWORD)).client
  viewer = (await enrolledClient(stack, 'vw@example.test', PASSWORD)).client
  bApprover = (await enrolledClient(stack, 'bap@example.test', PASSWORD)).client
})
afterAll(async () => {
  await stack?.close()
})
beforeEach(async () => {
  mailer = new DoubleMailer()
  channel = new DoubleAlertChannel()
  start = new Date()
  clock = new ManualClock(start)
  logged = []
  const sink = (...args: unknown[]) => void logged.push(JSON.stringify(args))
  deps = {
    pool: stack.appPool,
    mailer,
    channel,
    clock,
    audit: stack.audit,
    logger: { warn: sink, error: sink } as NotifyDeps['logger'],
  }
  await stack.db.admin.query('delete from app.notification')
  await stack.db.admin.query('delete from app.alert')
})

describe('notification delivery', () => {
  it('sends a queued notification and records the provider id', async () => {
    const id = await enqueue()
    expect((await notificationRow(id)).state).toBe('queued')
    const result = await deliverPending(stack.appPool, deps, 10)
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0 })
    const row = await notificationRow(id)
    expect(row).toMatchObject({ state: 'sent', provider_id: 'mail-1', attempts: 1 })
    expect(row.sent_at).toEqual(start)
    expect(mailer.sent[0]?.to).toBe(RECIPIENT)
    // Sent once only: a second pass finds nothing.
    expect((await deliverPending(stack.appPool, deps, 10)).sent).toBe(0)
  })

  it('counts the attempts when two sends fail and the third succeeds', async () => {
    const id = await enqueue()
    mailer.failNext(2)
    await deliverPending(stack.appPool, deps, 10)
    expect(await notificationRow(id)).toMatchObject({ state: 'queued', attempts: 1 })
    clock.advance(2 * 60_000)
    await deliverPending(stack.appPool, deps, 10)
    expect(await notificationRow(id)).toMatchObject({ state: 'queued', attempts: 2 })
    clock.advance(4 * 60_000)
    await deliverPending(stack.appPool, deps, 10)
    expect(await notificationRow(id)).toMatchObject({ state: 'sent', attempts: 3, provider_id: 'mail-1' })
    expect(await alertRows()).toHaveLength(0)
  })

  it('fails after five failures, raises one severity 2 alert, and stops trying', async () => {
    const id = await enqueue()
    mailer.failNext(99)
    for (let i = 0; i < 7; i += 1) {
      await deliverPending(stack.appPool, deps, 10)
      clock.advance(61 * 60_000)
    }
    expect(await notificationRow(id)).toMatchObject({ state: 'failed', attempts: 5 })
    // Five sends to the person, then the alert's two emails to the owners (which fail too, and stay undelivered).
    expect(mailer.attempts).toBe(5 + 2)
    const alerts = await alertRows()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ severity: 2, kind: 'notification_failed', brand_id: brandA })
    expect(alerts[0].detail).toEqual({ notificationId: id, ref: id })
  })

  it('waits 2^attempts minutes (at most 60) after a failure and skips the row until it is due', async () => {
    const MIN = 60_000
    const id = await enqueue()
    mailer.failNext(2)
    await deliverPending(stack.appPool, deps, 10)
    expect(mailer.attempts).toBe(1)
    expect((await notificationRow(id)).next_attempt_at).toEqual(new Date(start.getTime() + 2 * MIN))
    // Not due yet: nothing is tried, nothing is counted.
    clock.advance(1 * MIN)
    expect(await deliverPending(stack.appPool, deps, 10)).toEqual({ sent: 0, retried: 0, failed: 0 })
    expect(mailer.attempts).toBe(1)
    // Due at two minutes; the second failure waits four.
    clock.advance(1 * MIN)
    expect(await deliverPending(stack.appPool, deps, 10)).toEqual({ sent: 0, retried: 1, failed: 0 })
    expect(mailer.attempts).toBe(2)
    expect((await notificationRow(id)).next_attempt_at).toEqual(new Date(clock.now().getTime() + 4 * MIN))
    clock.advance(3 * MIN)
    await deliverPending(stack.appPool, deps, 10)
    expect(mailer.attempts).toBe(2)
    clock.advance(1 * MIN)
    expect((await deliverPending(stack.appPool, deps, 10)).sent).toBe(1)
    expect(await notificationRow(id)).toMatchObject({ state: 'sent', attempts: 3 })
  })

  it('caps the wait at 60 minutes', () => {
    expect(notificationBackoffMs(1)).toBe(2 * 60_000)
    expect(notificationBackoffMs(5)).toBe(32 * 60_000)
    expect(notificationBackoffMs(6)).toBe(60 * 60_000)
    expect(notificationBackoffMs(40)).toBe(60 * 60_000)
  })

  it('delivers a new notification at once, whatever is waiting for its time', async () => {
    const waiting = await enqueue()
    mailer.failNext(1)
    await deliverPending(stack.appPool, deps, 10)
    const fresh = await enqueue()
    await deliverPending(stack.appPool, deps, 10)
    expect((await notificationRow(fresh)).state).toBe('sent')
    expect((await notificationRow(waiting)).state).toBe('queued')
  })

  it('treats a send with no provider id as a failed attempt', async () => {
    const id = await enqueue()
    mailer.confirm = false
    await deliverPending(stack.appPool, deps, 10)
    expect(await notificationRow(id)).toMatchObject({ state: 'queued', attempts: 1, provider_id: null })
  })

  it('logs the error name only: no address, subject or message', async () => {
    await enqueue()
    mailer.failNext(1)
    await deliverPending(stack.appPool, deps, 10)
    const text = logged.join('\n')
    expect(text).toContain('Error')
    expect(text).not.toContain(RECIPIENT)
    expect(text).not.toContain('Marketing Sarathi')
    expect(text).not.toContain('transport down')
  })

  it('counts a missing recipient as a failed attempt', async () => {
    const id = await withBrand(stack.appPool, brandA, (client) =>
      enqueueNotification(client, {
        brandId: brandA,
        userId: '00000000-0000-4000-8000-000000000001',
        kind: 'reminder',
      }),
    )
    await deliverPending(stack.appPool, deps, 10)
    expect(await notificationRow(id)).toMatchObject({ state: 'queued', attempts: 1 })
    expect(mailer.attempts).toBe(0)
  })
})

describe('alert delivery', () => {
  it('is delivered only when both the emails and the second channel are confirmed', async () => {
    const result = await raiseAlert(stack.appPool, deps, {
      brandId: null,
      severity: 1,
      kind: 'audit_chain_mismatch',
      ref: 'platform:broken_chain',
    })
    expect(result).toMatchObject({ created: true, delivered: true })
    expect(mailer.sent.map((m) => m.to).sort()).toEqual([OWNER_1, OWNER_2])
    expect(channel.sent).toHaveLength(1)
    const [row] = await alertRows()
    expect(row.delivered_at).not.toBeNull()
    expect(row.delivery_attempts).toBe(1)
  })

  it('stays undelivered when the channel call throws, and the retry delivers it', async () => {
    channel.failNext(1)
    const first = await raiseAlert(stack.appPool, deps, {
      brandId: brandA,
      severity: 2,
      kind: 'dead_job',
      ref: 'j1',
    })
    expect(first).toMatchObject({ created: true, delivered: false })
    expect((await alertRows())[0]).toMatchObject({ delivered_at: null, delivery_attempts: 1 })
    clock.advance(2 * 60_000)
    expect(await retryAlerts(stack.appPool, deps, 10)).toBe(1)
    // Both owners were already emailed: only the channel leg is sent again.
    expect(mailer.sent).toHaveLength(2)
    expect((await alertRows())[0].delivered_at).not.toBeNull()
    expect(await retryAlerts(stack.appPool, deps, 10)).toBe(0)
  })

  it('stays undelivered when one email has no provider confirmation', async () => {
    mailer.confirm = false
    const result = await raiseAlert(stack.appPool, deps, {
      brandId: brandA,
      severity: 2,
      kind: 'dead_job',
      ref: 'j2',
    })
    expect(result.delivered).toBe(false)
    expect(channel.sent).toHaveLength(1)
    mailer.confirm = true
    clock.advance(2 * 60_000)
    expect(await retryAlerts(stack.appPool, deps, 10)).toBe(1)
    // The channel leg was confirmed the first time and is not sent again.
    expect(channel.sent).toHaveLength(1)
  })

  it('stays undelivered when the channel confirms but an email fails', async () => {
    mailer.failNext(1)
    const result = await raiseAlert(stack.appPool, deps, {
      brandId: brandA,
      severity: 2,
      kind: 'dead_job',
      ref: 'j3',
    })
    expect(result.delivered).toBe(false)
  })

  it('does not raise a second alert for the same kind and ref while one is unresolved', async () => {
    const one = await raiseAlert(stack.appPool, deps, {
      brandId: brandA,
      severity: 2,
      kind: 'dead_job',
      ref: 'same',
    })
    const two = await raiseAlert(stack.appPool, deps, {
      brandId: brandA,
      severity: 2,
      kind: 'dead_job',
      ref: 'same',
    })
    expect(one.created).toBe(true)
    expect(two).toEqual({ alertId: null, created: false, delivered: false })
    await raiseAlert(stack.appPool, deps, { brandId: brandB, severity: 2, kind: 'dead_job', ref: 'same' })
    await raiseAlert(stack.appPool, deps, { brandId: brandA, severity: 2, kind: 'dead_job', ref: 'other' })
    await raiseAlert(stack.appPool, deps, { brandId: null, severity: 2, kind: 'dead_job', ref: 'same' })
    await raiseAlert(stack.appPool, deps, { brandId: null, severity: 2, kind: 'dead_job', ref: 'same' })
    expect(await alertRows()).toHaveLength(4)
    // Once resolved, the same ref may be raised again.
    await stack.db.admin.query(
      "update app.alert set resolved_at = now() where brand_id = $1 and detail->>'ref' = 'same'",
      [brandA],
    )
    expect(
      (await raiseAlert(stack.appPool, deps, { brandId: brandA, severity: 2, kind: 'dead_job', ref: 'same' }))
        .created,
    ).toBe(true)
  })

  it('refuses a brand alert from another brand session', async () => {
    await expect(
      withBrand(stack.appPool, brandB, (c) =>
        c.query("select app.raise_alert($1, 2::smallint, 'x', '{}')", [brandA]),
      ),
    ).rejects.toThrow(/own brand/)
  })

  it('is undelivered when there is no platform owner to email', async () => {
    await stack.db.admin.query('alter table app.platform_owner disable trigger all')
    const saved = (await stack.db.admin.query('select * from app.platform_owner')).rows
    await stack.db.admin.query('delete from app.platform_owner')
    try {
      const result = await raiseAlert(stack.appPool, deps, {
        brandId: brandA,
        severity: 2,
        kind: 'dead_job',
        ref: 'noowner',
      })
      expect(result.delivered).toBe(false)
    } finally {
      for (const r of saved) {
        await stack.db.admin.query('insert into app.platform_owner (user_id, granted_at) values ($1, $2)', [
          r.user_id,
          r.granted_at,
        ])
      }
      await stack.db.admin.query('alter table app.platform_owner enable trigger all')
    }
  })
})

describe('alert wiring', () => {
  it('turns audit-verify findings into severity 1 alerts, per chain', async () => {
    const handler = auditMismatchHandler(stack.appPool, deps)
    await handler([
      { chainKey: brandA, kind: 'broken_chain', seq: 3, detail: 'x' },
      { chainKey: 'platform', kind: 'export_mismatch', seq: 9, detail: 'y' },
    ])
    await handler([{ chainKey: brandA, kind: 'broken_chain', seq: 3, detail: 'x' }])
    const rows = await alertRows()
    expect(rows.map((r) => [r.brand_id, r.severity, r.kind])).toEqual([
      [brandA, 1, 'audit_chain_mismatch'],
      [null, 1, 'audit_chain_mismatch'],
    ])
  })

  it('alerts on dead jobs, long-waiting jobs and unknown model calls, once each', async () => {
    const definitionId = await seedDefinition(stack.db)
    const make = async () => {
      let jobId = ''
      await withBrand(stack.appPool, brandA, async (client) => {
        const runId = await createRun(client, brandA, {
          agent: 'test-agent',
          definitionVersionId: definitionId,
          startedByKind: 'system',
          startedById: null,
        })
        jobId = await createJob(client, stack.jobs!, brandA, {
          runId,
          jobClass: 'interactive',
          input: {},
          expectedResultType: 'test.echo',
        })
      })
      return jobId
    }
    const dead = await make()
    const waiting = await make()
    const fresh = await make()
    await stack.db.admin.query('update app.job_control set dead_at = now() where job_id = $1', [dead])
    await stack.db.admin.query(
      "update app.job_input set created_at = now() - interval '2 hours' where job_id in ($1, $2)",
      [dead, waiting],
    )
    expect(await alertOnOperationalFindings(stack.appPool, deps)).toBe(2)
    expect(await alertOnOperationalFindings(stack.appPool, deps)).toBe(0)
    const rows = await alertRows()
    expect(rows.map((r) => [r.kind, r.detail.ref]).sort()).toEqual(
      [
        ['dead_job', dead],
        ['waiting_job', waiting],
      ].sort(),
    )
    expect(rows.find((r) => r.detail.ref === fresh)).toBeUndefined()
    // Unknown model calls.
    const attempt = await stack.db.admin.query(
      `insert into app.job_attempt (brand_id, job_id, attempt_number, worker_id, token_id) values ($1, $2, 1, 'w', gen_random_uuid()) returning id`,
      [brandA, fresh],
    )
    const runId = (await stack.db.admin.query('select run_id from app.job_input where job_id = $1', [fresh]))
      .rows[0].run_id
    const call = await stack.db.admin.query(
      `insert into app.model_call (brand_id, run_id, job_id, attempt_id, step, request_hash, model, status)
       values ($1, $2, $3, $4, 's', 'h', 'm', 'unknown') returning id`,
      [brandA, runId, fresh, attempt.rows[0].id],
    )
    expect(await alertOnOperationalFindings(stack.appPool, deps)).toBe(1)
    expect((await alertRows("kind = 'unknown_model_call'"))[0].detail.ref).toBe(call.rows[0].id)
  })
})

describe('recipients', () => {
  it('lists approvers, brand admins and platform owners, and resolves an address', async () => {
    const approvers = await withBrand(stack.appPool, brandA, (c) => approversOf(c, brandA))
    expect(approvers).toHaveLength(2)
    expect(approvers).toContain(recipientId)
    expect(await withBrand(stack.appPool, brandA, (c) => brandAdminsOf(c, brandA))).toHaveLength(1)
    expect(await withBrand(stack.appPool, brandB, (c) => approversOf(c, brandA))).toEqual([])
    expect(await platformOwnersOf(stack.appPool)).toHaveLength(2)
    expect(await emailOf(stack.appPool, recipientId)).toBe(RECIPIENT)
    expect(await emailOf(stack.appPool, '00000000-0000-4000-8000-000000000001')).toBeNull()
  })
})

describe('alert routes', () => {
  const api = (p: string) => `/api/v1${p}`
  const post = (c: TestClient, p: string) => c.request('POST', api(p), { body: {} })

  it('lists a brand its own alerts and never a platform alert', async () => {
    await raiseAlert(stack.appPool, deps, { brandId: brandA, severity: 2, kind: 'dead_job', ref: 'r1' })
    await raiseAlert(stack.appPool, deps, {
      brandId: null,
      severity: 1,
      kind: 'audit_chain_mismatch',
      ref: 'p1',
    })
    await raiseAlert(stack.appPool, deps, { brandId: brandB, severity: 2, kind: 'dead_job', ref: 'b1' })
    const mine = await viewer.request('GET', api(`/brands/${brandA}/alerts`))
    expect(mine.status).toBe(200)
    expect(mine.json.alerts.map((a: { kind: string }) => a.kind)).toEqual(['dead_job'])
    expect(mine.json.alerts[0]).toMatchObject({ severity: 2, delivered: true, acknowledgedAt: null })
    // Even the platform owner, asking by brand, sees the brand's alerts and no platform alert.
    const asOwner = await owner.request('GET', api(`/brands/${brandA}/alerts`))
    expect(asOwner.json.alerts).toHaveLength(1)
    const platform = await owner.request('GET', api('/alerts'))
    expect(platform.json.alerts.map((a: { kind: string }) => a.kind)).toEqual(['audit_chain_mismatch'])
    expect((await viewer.request('GET', api('/alerts'))).status).toBe(403)
    expect((await approver.request('GET', api('/alerts'))).status).toBe(403)
  })

  it('lets an approver acknowledge a brand alert, audited; a viewer gets 403', async () => {
    await raiseAlert(stack.appPool, deps, { brandId: brandA, severity: 2, kind: 'dead_job', ref: 'ack1' })
    const id = (await alertRows())[0].id as string
    const denied = await post(viewer, `/brands/${brandA}/alerts/${id}/ack`)
    expect(denied.status).toBe(403)
    expect((await alertRows())[0].acknowledged_at).toBeNull()
    const before = stack.audit.entries.length
    const ok = await post(approver, `/brands/${brandA}/alerts/${id}/ack`)
    expect(ok.status).toBe(200)
    expect(ok.json.acknowledgedAt).not.toBeNull()
    const entries = stack.audit.entries.slice(before)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      action: 'alerts.acknowledged',
      brandId: brandA,
      subject: id,
      outcome: 'success',
    })
    // Repeating it changes and audits nothing more.
    const again = await post(approver, `/brands/${brandA}/alerts/${id}/ack`)
    expect(again.status).toBe(200)
    expect(stack.audit.entries.slice(before)).toHaveLength(1)
  })

  it("answers 404 to an acknowledgement of another brand's alert or a platform alert", async () => {
    await raiseAlert(stack.appPool, deps, { brandId: brandA, severity: 2, kind: 'dead_job', ref: 'x1' })
    await raiseAlert(stack.appPool, deps, {
      brandId: null,
      severity: 1,
      kind: 'audit_chain_mismatch',
      ref: 'x2',
    })
    const brandAlert = (await alertRows('brand_id is not null'))[0].id as string
    const platformAlert = (await alertRows('brand_id is null'))[0].id as string
    expect((await post(bApprover, `/brands/${brandB}/alerts/${brandAlert}/ack`)).status).toBe(404)
    expect((await post(approver, `/brands/${brandA}/alerts/${platformAlert}/ack`)).status).toBe(404)
    expect(
      (await post(approver, `/brands/${brandA}/alerts/00000000-0000-4000-8000-000000000009/ack`)).status,
    ).toBe(404)
    expect((await alertRows()).every((r) => r.acknowledged_at === null)).toBe(true)
  })

  it('lets the platform owner acknowledge a platform alert, audited; others get 403', async () => {
    await raiseAlert(stack.appPool, deps, {
      brandId: null,
      severity: 1,
      kind: 'audit_chain_mismatch',
      ref: 'pa',
    })
    await raiseAlert(stack.appPool, deps, { brandId: brandA, severity: 2, kind: 'dead_job', ref: 'ba' })
    const id = (await alertRows('brand_id is null'))[0].id as string
    const brandAlert = (await alertRows('brand_id is not null'))[0].id as string
    expect((await post(approver, `/alerts/${id}/ack`)).status).toBe(403)
    // The platform route does not reach a brand's alert.
    expect((await post(owner, `/alerts/${brandAlert}/ack`)).status).toBe(404)
    const before = stack.audit.entries.length
    const ok = await post(owner, `/alerts/${id}/ack`)
    expect(ok.status).toBe(200)
    expect(ok.json.acknowledgedAt).not.toBeNull()
    expect(stack.audit.entries.slice(before)).toMatchObject([
      { action: 'alerts.acknowledged', brandId: null, subject: id },
    ])
    expect((await post(owner, `/alerts/${id}/ack`)).status).toBe(200)
    expect(stack.audit.entries.slice(before)).toHaveLength(1)
  })
})

describe('reconciliation timer', () => {
  it('raises alerts and delivers what is queued, and still answers with the sweep count', async () => {
    const own = await createStack({ withQueue: true, alertChannel: new DoubleAlertChannel(), clock })
    try {
      const brand = await addBrand(own, 'timer-a')
      await addUser(own, { email: 'o@example.test', password: PASSWORD, platformOwner: true })
      const user = await addUser(own, {
        email: 'u@example.test',
        password: PASSWORD,
        role: 'approver',
        brandId: brand,
      })
      await withBrand(own.appPool, brand, (c) =>
        enqueueNotification(c, { brandId: brand, userId: user, kind: 'reminder' }),
      )
      const headers = {
        authorization: `Worker ${own.jobs!.workerSecret}`,
        'content-type': 'application/json',
      }
      const res = await fetch(`${own.server.url}/api/v1/worker/reconcile`, {
        method: 'POST',
        headers,
        body: '{}',
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ marked: 0 })
      const sent = await own.db.admin.query("select state from app.notification where kind = 'reminder'")
      expect(sent.rows[0].state).toBe('sent')
      expect((own.mailer as { sent: unknown[] }).sent).toHaveLength(1)
    } finally {
      await own.close()
    }
  })
})

describe('alert retry policy', () => {
  const alert = (ref: string) =>
    raiseAlert(stack.appPool, deps, { brandId: brandA, severity: 2, kind: 'dead_job', ref })
  const MIN = 60_000

  it('resends only the owner whose email failed', async () => {
    mailer.failNext(1)
    await alert('leg')
    expect(mailer.sent).toHaveLength(1)
    expect((await alertRows())[0].mailed_to).toHaveLength(1)
    clock.advance(2 * MIN)
    expect(await retryAlerts(stack.appPool, deps, 10)).toBe(1)
    expect(mailer.sent).toHaveLength(2)
    expect(new Set(mailer.sent.map((m) => m.to)).size).toBe(2)
    expect(channel.sent).toHaveLength(1)
  })

  it('waits 2^attempts minutes (at most 60) between retries, by the controlled clock', async () => {
    channel.failNext(99)
    await alert('backoff')
    // One attempt so far: due after 2 minutes.
    clock.advance(1 * MIN)
    expect(await retryAlerts(stack.appPool, deps, 10)).toBe(0)
    expect(channel.attempts).toBe(1)
    clock.advance(1 * MIN)
    await retryAlerts(stack.appPool, deps, 10)
    expect(channel.attempts).toBe(2)
    // Two attempts: now 4 minutes.
    clock.advance(3 * MIN)
    await retryAlerts(stack.appPool, deps, 10)
    expect(channel.attempts).toBe(2)
    clock.advance(1 * MIN)
    await retryAlerts(stack.appPool, deps, 10)
    expect(channel.attempts).toBe(3)
    // The wait is capped at 60 minutes.
    await stack.db.admin.query('update app.alert set delivery_attempts = 9')
    clock.advance(60 * MIN)
    await retryAlerts(stack.appPool, deps, 10)
    expect(channel.attempts).toBe(4)
  })

  it('stalls after 10 attempts, stops retrying and shows it in the listing', async () => {
    channel.failNext(99)
    await alert('stall')
    for (let i = 0; i < 12; i += 1) {
      clock.advance(61 * MIN)
      await retryAlerts(stack.appPool, deps, 10)
    }
    const [row] = await alertRows()
    expect(row).toMatchObject({
      delivery_attempts: 10,
      delivery_stalled: true,
      delivery_issue: 'channel',
      delivered_at: null,
    })
    expect(channel.attempts).toBe(10)
    const listed = await viewer.request('GET', `/api/v1/brands/${brandA}/alerts`)
    expect(listed.json.alerts[0]).toMatchObject({
      delivered: false,
      deliveryAttempts: 10,
      deliveryStalled: true,
      deliveryIssue: 'channel',
    })
  })

  it('surfaces a missing platform owner as the issue and stalls the same way', async () => {
    const saved = (await stack.db.admin.query('select * from app.platform_owner')).rows
    await stack.db.admin.query('delete from app.platform_owner')
    try {
      await alert('noowner2')
      expect((await alertRows())[0].delivery_issue).toBe('no_platform_owner')
      for (let i = 0; i < 12; i += 1) {
        clock.advance(61 * MIN)
        await retryAlerts(stack.appPool, deps, 10)
      }
      expect((await alertRows())[0]).toMatchObject({ delivery_stalled: true, delivery_attempts: 10 })
    } finally {
      for (const r of saved) {
        await stack.db.admin.query('insert into app.platform_owner (user_id, granted_at) values ($1, $2)', [
          r.user_id,
          r.granted_at,
        ])
      }
    }
  })

  it('acknowledges an alert older than the newest 200 and answers with it', async () => {
    await raiseAlert(stack.appPool, deps, { brandId: null, severity: 1, kind: 'old_one', ref: 'old' })
    const id = (await alertRows('kind = $$old_one$$'))[0].id as string
    for (let i = 0; i < 201; i += 1) {
      await stack.db.admin.query(
        "insert into app.alert (brand_id, severity, kind, detail) values (null, 3, 'filler', $1::jsonb)",
        [JSON.stringify({ ref: `f${i}` })],
      )
    }
    const ok = await owner.request('POST', `/api/v1/alerts/${id}/ack`, { body: {} })
    expect(ok.status).toBe(200)
    expect(ok.json.id).toBe(id)
  })
})

describe('notify tick', () => {
  it('runs every stage even when the first throws, naming the failure only', async () => {
    await enqueue()
    const broken = {
      query: (text: string, ...rest: unknown[]) => {
        if (String(text).includes('operational_findings'))
          return Promise.reject(new Error('secret@example.test'))
        return (stack.appPool.query as (...a: unknown[]) => unknown)(text, ...rest)
      },
      connect: () => stack.appPool.connect(),
    } as unknown as NotifyDeps['pool']
    const failed = await runNotifyTick({ ...deps, pool: broken })
    expect(failed).toEqual(['findings'])
    expect(mailer.sent).toHaveLength(1)
    expect(logged.join('\n')).toContain('notify stage failed')
    expect(logged.join('\n')).not.toContain('secret@example.test')
  })

  it('does not let a hung transport stall the tick, and stops starting sends over the budget', async () => {
    // Nothing else for the tick to report (earlier tests left jobs and a model call behind).
    await stack.db.admin.query('update app.job_input set finished_at = now() where finished_at is null')
    await stack.db.admin.query("update app.model_call set status = 'failed' where status = 'unknown'")
    await enqueue()
    await enqueue()
    mailer.hang = true
    const slow = { ...deps, sendTimeoutMs: 300, tickBudgetMs: 250 }
    const t0 = Date.now()
    const failed = await runNotifyTick(slow)
    expect(failed).toEqual([])
    expect(Date.now() - t0).toBeLessThan(2000)
    // Each hung send timed out and counted an attempt; the budget stopped further starts in the tick.
    const rows = (await stack.db.admin.query('select attempts, state from app.notification')).rows
    expect(rows.every((r) => r.state === 'queued')).toBe(true)
    expect(rows.reduce((n, r) => n + r.attempts, 0)).toBe(1)
    expect(mailer.attempts).toBe(1)
    expect(logged.join('\n')).toContain('SendTimeout')
  })
})

describe('the n8n heartbeat watch', () => {
  const setHeartbeat = async (ageHours: number | null) => {
    await stack.db.admin.query('delete from app.duty_run')
    if (ageHours === null) return
    const at = new Date(clock.now().getTime() - ageHours * 3_600_000)
    await stack.db.admin.query(
      "insert into app.duty_run (duty, run_date, state, started_at, finished_at) values ('n8n_heartbeat', $1, 'done', $2, $2)",
      [at.toISOString().slice(0, 10), at],
    )
  }
  const missing = () => alertRows("kind = 'n8n_heartbeat_missing'")

  it('raises nothing when the heartbeat is not expected, even with none on record', async () => {
    await setHeartbeat(null)
    expect(await alertOnOperationalFindings(stack.appPool, deps)).toBe(0)
    expect(await missing()).toHaveLength(0)
  })

  it('raises one severity 2 platform alert when it is expected and 27 hours old, and not a second', async () => {
    deps.heartbeatExpected = true
    await setHeartbeat(27)
    expect(await alertOnOperationalFindings(stack.appPool, deps)).toBe(1)
    expect(await alertOnOperationalFindings(stack.appPool, deps)).toBe(0)
    const rows = await missing()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ severity: 2, brand_id: null })
  })

  it('raises one when it is expected and none was ever recorded', async () => {
    deps.heartbeatExpected = true
    await setHeartbeat(null)
    await alertOnOperationalFindings(stack.appPool, deps)
    expect(await missing()).toHaveLength(1)
  })

  it('raises nothing for a heartbeat 25 hours old; a fresh one resolves nothing and opens nothing new', async () => {
    deps.heartbeatExpected = true
    await setHeartbeat(25)
    expect(await alertOnOperationalFindings(stack.appPool, deps)).toBe(0)
    await setHeartbeat(27)
    await alertOnOperationalFindings(stack.appPool, deps)
    await setHeartbeat(1)
    expect(await alertOnOperationalFindings(stack.appPool, deps)).toBe(0)
    const rows = await missing()
    expect(rows).toHaveLength(1)
    expect(rows[0].resolved_at).toBeNull()
  })
})
