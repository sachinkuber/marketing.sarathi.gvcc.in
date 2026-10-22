import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agentsReply,
  alertsReply,
  approvalSettingsReply,
  auditReply,
  auditVerifyReply,
  brandReply,
  brandsReply,
  contentItemReply,
  contentListReply,
  deadJobsReply,
  homeReply,
  inviteCreatedReply,
  killSwitchReply,
  modelCallReviewReply,
  noContent,
  overdueAllReply,
  overdueReply,
  roleChangedReply,
  runDetailReply,
  runStartedReply,
  runsReply,
  sessionReply,
  shadowModeReply,
  statusReply,
  switchReleasedReply,
  switchSetReply,
  usersReply,
} from '../../dashboard/src/api/schemas.ts'
import {
  api,
  cast,
  readsStack,
  seedAwaiting,
  seedCall,
  seedJob,
  seedRun,
  NOW,
  PASSWORD,
  type Cast,
} from './reads-support.ts'
import { addUser, enrolledClient, totp, type Stack, type TestClient } from './support.ts'

// The dashboard parses every reply with the schema of the same name; the core's real replies must satisfy them.
let stack: Stack
let c: Cast
let runId: string
let itemId: string

beforeAll(async () => {
  // With the queue: starting an agent and the dead-letter routes exist only with the work engine.
  stack = await readsStack(undefined, { withQueue: true })
  c = await cast(stack)
  runId = await seedRun(stack, c.brandId, { usd: 2_000_000n, inr: 166_000_000n })
  await seedRun(stack, c.brandId, { state: 'running' })
  await seedJob(stack, c.brandId, runId, { finished: true, attempts: ['failed', 'succeeded'] })
  await seedJob(stack, c.brandId, runId, { dead: true, attempts: ['failed'] })
  await seedCall(stack, c.brandId, runId, { status: 'unknown' })
  await seedCall(stack, c.brandId, runId)
  const versionId = await seedAwaiting(stack, c.brandId, new Date(NOW.getTime() - 3_600_000))
  const version = await stack.db.admin.query(
    'select content_item_id from app.content_version where id = $1',
    [versionId],
  )
  itemId = version.rows[0].content_item_id as string
  await stack.db.admin.query('update app.content_item set current_version_id = $2 where id = $1', [
    itemId,
    versionId,
  ])
  await stack.db.admin.query(
    `insert into app.check_result (brand_id, content_version_id, check_name, kind, passed, detail)
     values ($1, $2, 'placeholder_length', 'blocking', true, '{"summaryLength":1}')`,
    [c.brandId, versionId],
  )
  await stack.db.admin.query(
    `insert into app.alert (brand_id, severity, kind, detail) values ($1, 2, 'dead_job', '{}'), (null, 1, 'n8n_heartbeat_missing', null)`,
    [c.brandId],
  )
  await stack.auditPool!.query(
    `select audit.append($1::uuid, 'system', null, 'test.run_event', 'success', $2, '{"k":1}'::jsonb)`,
    [c.brandId, runId],
  )
})
afterAll(async () => stack?.close())

const get = async (who: 'admin' | 'owner' | 'approver' | 'viewer', path: string) => {
  const reply = await c[who].request('GET', path)
  expect(reply.status, path).toBe(200)
  return reply.json
}

describe('the dashboard schemas accept the core’s replies', () => {
  it('status', async () => {
    for (const who of ['admin', 'viewer'] as const) {
      statusReply.parse(await get(who, api(c.brandId, '/status')))
    }
  })
  it('home, for every kind of reader', async () => {
    for (const who of ['admin', 'owner', 'approver', 'viewer'] as const) {
      homeReply.parse(await get(who, api(c.brandId, '/home')))
    }
  })
  it('agents', async () => {
    agentsReply.parse(await get('admin', api(c.brandId, '/agents')))
  })
  it('runs, and the same with a cursor and an agent filter', async () => {
    const page = runsReply.parse(await get('admin', api(c.brandId, '/runs')))
    expect(page.items.length).toBeGreaterThan(0)
    runsReply.parse(await get('admin', api(c.brandId, '/runs?agent=summary')))
  })
  it('run detail', async () => {
    const detail = runDetailReply.parse(await get('admin', api(c.brandId, `/runs/${runId}`)))
    expect(detail.jobs.length).toBe(4)
    expect(detail.modelCalls.length).toBe(2)
    expect(detail.audit.length).toBe(1)
  })
  it('model-call review', async () => {
    const review = modelCallReviewReply.parse(await get('admin', api(c.brandId, '/model-calls/review')))
    expect(review.items.length).toBe(2)
  })
  it('audit search, brand and platform', async () => {
    expect(auditReply.parse(await get('admin', api(c.brandId, '/audit'))).items.length).toBeGreaterThan(0)
    auditReply.parse(await get('owner', '/api/v1/audit/platform'))
  })
  it('audit verify, brand and platform', async () => {
    for (const [who, path] of [
      ['admin', api(c.brandId, '/audit/verify')],
      ['owner', '/api/v1/audit/platform/verify'],
    ] as const) {
      const reply = await c[who].request('POST', path, { body: {} })
      expect(reply.status).toBe(200)
      auditVerifyReply.parse(reply.json)
    }
  })

  it('session, brands, one brand, and the overdue reads (the shell’s own reads)', async () => {
    for (const who of ['admin', 'owner', 'approver', 'viewer'] as const) {
      sessionReply.parse(await get(who, '/api/v1/session'))
    }
    brandsReply.parse(await get('admin', '/api/v1/brands'))
    const ownerBrands = brandsReply.parse(await get('owner', '/api/v1/brands'))
    expect(ownerBrands.brands.map((b) => b.id)).toContain(c.brandId)
    brandReply.parse(await get('viewer', api(c.brandId, '')))
    overdueReply.parse(await get('approver', api(c.brandId, '/approvals/overdue')))
    for (const who of ['admin', 'owner', 'approver', 'viewer'] as const) {
      overdueAllReply.parse(await get(who, '/api/v1/overdue'))
    }
  })

  it('the inbox list and one item, with the check results of each version', async () => {
    for (const query of ['', '?state=awaiting_approval', '?state=awaiting_approval&overdue=true']) {
      contentListReply.parse(await get('viewer', api(c.brandId, `/content${query}`)))
    }
    const list = contentListReply.parse(await get('approver', api(c.brandId, '/content')))
    expect(list.items.map((i) => i.id)).toContain(itemId)
    const item = contentItemReply.parse(await get('approver', api(c.brandId, `/content/${itemId}`)))
    expect(item.versions[0]?.checks).toEqual([
      expect.objectContaining({ name: 'placeholder_length', kind: 'blocking', passed: true }),
    ])
  })
  it('approval settings and alerts, brand and platform', async () => {
    approvalSettingsReply.parse(await get('admin', api(c.brandId, '/approval-settings')))
    const brand = alertsReply.parse(await get('viewer', api(c.brandId, '/alerts')))
    expect(brand.alerts.length).toBeGreaterThan(0)
    const platform = alertsReply.parse(await get('owner', '/api/v1/alerts'))
    expect(platform.alerts.length).toBeGreaterThan(0)
  })

  describe('the agents, dead letters, users and safety screens (Task 13), with the step-up code', () => {
    let admin: { client: TestClient; secret: string }
    let owner: { client: TestClient; secret: string }
    let targetId: string
    // A 204 has no body; the dashboard's client reads that as null.
    const empty = (reply: { status: number; text: string }) => {
      expect(reply.status).toBe(204)
      return noContent.parse(reply.text === '' ? null : JSON.parse(reply.text))
    }

    beforeAll(async () => {
      await addUser(stack, {
        email: 'contract-admin@example.test',
        password: PASSWORD,
        role: 'brand_admin',
        brandId: c.brandId,
      })
      admin = await enrolledClient(stack, 'contract-admin@example.test', PASSWORD)
      await addUser(stack, { email: 'contract-owner@example.test', password: PASSWORD, platformOwner: true })
      owner = await enrolledClient(stack, 'contract-owner@example.test', PASSWORD)
      targetId = await addUser(stack, {
        email: 'contract-target@example.test',
        password: PASSWORD,
        role: 'approver',
        brandId: c.brandId,
      })
      await enrolledClient(stack, 'contract-target@example.test', PASSWORD)
    })

    it('starting the summary agent, and the dead-letter list', async () => {
      const start = await owner.client.request('POST', api(c.brandId, '/agents/summary/runs'), {
        body: { brief: 'Three questions to ask a studio.' },
      })
      expect(start.status).toBe(201)
      runStartedReply.parse(start.json)
      const dead = deadJobsReply.parse(
        await owner.client.request('GET', api(c.brandId, '/jobs/dead')).then((r) => r.json),
      )
      expect(dead.length).toBeGreaterThan(0)
    })

    it('users: the list, an invite, a role change, a second-factor reset and a removal', async () => {
      usersReply.parse((await admin.client.request('GET', api(c.brandId, '/users'))).json)
      const invite = await admin.client.request('POST', api(c.brandId, '/users/invites'), {
        body: { email: 'contract-invited@example.test', role: 'viewer' },
      })
      expect(invite.status).toBe(201)
      inviteCreatedReply.parse(invite.json)
      const listed = usersReply.parse((await admin.client.request('GET', api(c.brandId, '/users'))).json)
      expect(listed.pendingInvites.map((i) => i.email)).toContain('contract-invited@example.test')
      expect(listed.members.find((m) => m.userId === targetId)?.twoFactorEnabled).toBe(true)

      const changed = await admin.client.request('PATCH', api(c.brandId, `/users/${targetId}`), {
        body: { role: 'viewer', code: totp(admin.secret) },
      })
      expect(changed.status).toBe(200)
      expect(roleChangedReply.parse(changed.json)).toEqual({ userId: targetId, role: 'viewer' })
      empty(
        await owner.client.request('POST', `/api/v1/users/${targetId}/second-factor/reset`, {
          body: { code: totp(owner.secret) },
        }),
      )
      empty(
        await admin.client.request('DELETE', api(c.brandId, `/users/${targetId}`), {
          body: { code: totp(admin.secret) },
        }),
      )
    })

    it('the kill switch: the list, set, release, and the owner’s shadow toggle', async () => {
      const read = async () =>
        killSwitchReply.parse((await admin.client.request('GET', api(c.brandId, '/kill-switch'))).json)
      expect((await read()).switches).toEqual([])
      const set = await admin.client.request('POST', api(c.brandId, '/kill-switch'), {
        body: { scope: 'channel', target: 'instagram', code: totp(admin.secret) },
      })
      expect(set.status).toBe(200)
      expect(switchSetReply.parse(set.json)).toMatchObject({ created: true, held: 0 })
      expect((await read()).switches.map((s) => s.target)).toEqual(['instagram'])
      const released = await admin.client.request('POST', api(c.brandId, '/kill-switch/release'), {
        body: { scope: 'channel', target: 'instagram', code: totp(admin.secret) },
      })
      expect(released.status).toBe(200)
      expect(switchReleasedReply.parse(released.json)).toEqual({ released: true, unheld: 0 })
      for (const value of [true, false]) {
        const shadow = await owner.client.request('PATCH', api(c.brandId, '/shadow-mode'), {
          body: { shadow_mode: value },
        })
        expect(shadow.status).toBe(200)
        expect(shadowModeReply.parse(shadow.json)).toEqual({ shadowMode: value })
      }
    })
  })

  it('refuses a reply with an unexpected shape, so the schemas are not vacuous', () => {
    expect(() => statusReply.parse({ killSwitch: { active: 'yes', scopes: [] } })).toThrow()
    expect(() =>
      modelCallReviewReply.parse({ items: [{ id: 'x', cost: { usdMicros: 5, inrMicros: 6 } }] }),
    ).toThrow()
  })
})
