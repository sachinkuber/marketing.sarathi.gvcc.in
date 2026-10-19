import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJob, createRun, postResult, registerModelCall, startAttempt } from '../src/jobs/service.ts'
import type { JobsDeps } from '../src/jobs/service.ts'
import { verifyAttemptToken } from '../src/jobs/token.ts'
import { releaseSwitch, setSwitch } from '../src/killswitch/service.ts'
import {
  addBrand,
  addUser,
  createStack,
  enrolledClient,
  totp,
  type Stack,
  type TestClient,
} from './support.ts'

const PASSWORD = 'correct horse battery'

let stack: Stack
let jobs: JobsDeps
let definitionId: string
let seq = 0
let owner: TestClient
let ownerSecret: string

interface Setup {
  brandId: string
  adminId: string
  admin: TestClient
  secret: string
  approver: TestClient
  viewer: TestClient
}

async function makeBrand(): Promise<Setup> {
  seq += 1
  const brandId = await addBrand(stack, `ks-${seq}`)
  const adminId = await addUser(stack, {
    email: `ad${seq}@example.test`,
    password: PASSWORD,
    role: 'brand_admin',
    brandId,
  })
  await addUser(stack, { email: `ap${seq}@example.test`, password: PASSWORD, role: 'approver', brandId })
  await addUser(stack, { email: `vw${seq}@example.test`, password: PASSWORD, role: 'viewer', brandId })
  const admin = await enrolledClient(stack, `ad${seq}@example.test`, PASSWORD)
  return {
    brandId,
    adminId,
    admin: admin.client,
    secret: admin.secret,
    approver: (await enrolledClient(stack, `ap${seq}@example.test`, PASSWORD)).client,
    viewer: (await enrolledClient(stack, `vw${seq}@example.test`, PASSWORD)).client,
  }
}

async function newJob(brandId: string, agent: string): Promise<string> {
  return withBrand(stack.appPool, brandId, async (client) => {
    const runId = await createRun(client, brandId, {
      agent,
      definitionVersionId: definitionId,
      startedByKind: 'system',
      startedById: null,
    })
    return createJob(client, jobs, brandId, {
      runId,
      jobClass: 'interactive',
      input: {},
      expectedResultType: 'test.echo',
    })
  })
}

const heldOf = async (ids: string[]): Promise<boolean[]> =>
  (
    await stack.db.admin.query(
      'select held from app.job_control where job_id = any($1) order by array_position($1, job_id)',
      [ids],
    )
  ).rows.map((r) => r.held as boolean)

const path = (brandId: string, tail = '') => `/api/v1/brands/${brandId}/kill-switch${tail}`
const actions = (name: string, brandId: string) =>
  stack.audit.entries.filter((e) => e.action === name && e.brandId === brandId)

beforeAll(async () => {
  stack = await createStack({ withQueue: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  definitionId = await seedDefinition(stack.db)
  await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
  const o = await enrolledClient(stack, 'owner@example.test', PASSWORD)
  owner = o.client
  ownerSecret = o.secret
})
afterAll(async () => {
  await stack?.close()
})

describe('setting and releasing the kill switch over HTTP', () => {
  it('refuses a missing, malformed or wrong code, and holds nothing', async () => {
    const b = await makeBrand()
    const job = await newJob(b.brandId, 'writer')
    expect((await b.admin.request('POST', path(b.brandId), { body: { scope: 'brand' } })).status).toBe(400)
    expect(
      (await b.admin.request('POST', path(b.brandId), { body: { scope: 'brand', code: '12' } })).status,
    ).toBe(400)
    stack.audit.entries.length = 0
    const wrong = await b.admin.request('POST', path(b.brandId), { body: { scope: 'brand', code: '000000' } })
    expect(wrong.status).toBe(403)
    expect(wrong.json.error.code).toBe('second_factor_invalid')
    expect(
      stack.audit.entries.some((e) => e.action === 'auth.second_factor' && e.outcome === 'failure'),
    ).toBe(true)
    expect(actions('killswitch.set', b.brandId)).toHaveLength(0)
    expect(await heldOf([job])).toEqual([false])
    const wrongRelease = await b.admin.request('POST', path(b.brandId, '/release'), {
      body: { scope: 'brand', code: '000000' },
    })
    expect(wrongRelease.status).toBe(403)
  })

  it('needs a target for channel and agent scope, and none for brand', async () => {
    const b = await makeBrand()
    const code = totp(b.secret)
    expect((await b.admin.request('POST', path(b.brandId), { body: { scope: 'agent', code } })).status).toBe(
      400,
    )
    expect(
      (await b.admin.request('POST', path(b.brandId), { body: { scope: 'brand', target: 'x', code } }))
        .status,
    ).toBe(400)
    expect((await b.admin.request('POST', path(b.brandId), { body: { scope: 'nope', code } })).status).toBe(
      400,
    )
  })

  it('a brand switch holds every waiting job, is audited, shown, and held jobs answer held', async () => {
    const b = await makeBrand()
    const j1 = await newJob(b.brandId, 'writer')
    const j2 = await newJob(b.brandId, 'designer')
    const other = await makeBrand()
    const otherJob = await newJob(other.brandId, 'writer')
    await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
      j1,
    ])
    const started = await startAttempt(jobs, j1, 'w1')
    if (started.finished || 'outcome' in started) throw new Error('unexpected')
    const check = verifyAttemptToken(
      jobs.attemptTokenSecret,
      started.token,
      Math.floor(jobs.now().getTime() / 1000),
    )
    if (!check.ok) throw new Error('token')

    const set = await b.admin.request('POST', path(b.brandId), {
      body: { scope: 'brand', code: totp(b.secret) },
    })
    expect(set.status).toBe(200)
    expect(set.json).toMatchObject({ held: 2, switch: { scope: 'brand', target: null, active: true } })
    expect(await heldOf([j1, j2])).toEqual([true, true])
    expect(await heldOf([otherJob])).toEqual([false])
    expect(actions('killswitch.set', b.brandId)[0]).toMatchObject({
      actor: b.adminId,
      outcome: 'success',
      detail: { scope: 'brand', target: null, held: 2 },
    })

    // No model call is registered for a held job.
    const reg = await registerModelCall(jobs, check.claims, { step: 's', requestHash: 'h', model: 'm' })
    expect(reg).toEqual({ outcome: 'held' })
    const calls = await stack.db.admin.query(
      'select count(*)::int as n from app.model_call where job_id = $1',
      [j1],
    )
    expect(calls.rows[0].n).toBe(0)

    const shown = await b.admin.request('GET', path(b.brandId))
    expect(shown.status).toBe(200)
    expect(shown.json.shadowMode).toBe(false)
    expect(shown.json.switches).toHaveLength(1)
    expect(shown.json.switches[0]).toMatchObject({ scope: 'brand', target: null })

    const rel = await b.admin.request('POST', path(b.brandId, '/release'), {
      body: { scope: 'brand', code: totp(b.secret) },
    })
    expect(rel.status).toBe(200)
    expect(rel.json).toMatchObject({ released: true, unheld: 2 })
    expect(await heldOf([j1, j2])).toEqual([false, false])
    expect(actions('killswitch.released', b.brandId)).toHaveLength(1)
    expect((await b.admin.request('GET', path(b.brandId))).json.switches).toEqual([])
  })

  it('refuses approver and viewer, and another brand answers 404', async () => {
    const b = await makeBrand()
    const other = await makeBrand()
    for (const who of [b.approver, b.viewer]) {
      expect((await who.request('GET', path(b.brandId))).status).toBe(403)
      expect(
        (await who.request('POST', path(b.brandId), { body: { scope: 'brand', code: '123456' } })).status,
      ).toBe(403)
      expect(
        (await who.request('POST', path(b.brandId, '/release'), { body: { scope: 'brand', code: '123456' } }))
          .status,
      ).toBe(403)
    }
    expect((await other.admin.request('GET', path(b.brandId))).status).toBe(404)
    expect(
      (
        await other.admin.request('POST', path(b.brandId), {
          body: { scope: 'brand', code: totp(other.secret) },
        })
      ).status,
    ).toBe(404)
  })

  it('shadow mode: brand admin 403, platform owner 200 and audited, shown by the GET', async () => {
    const b = await makeBrand()
    const denied = await b.admin.request('PATCH', `/api/v1/brands/${b.brandId}/shadow-mode`, {
      body: { shadow_mode: true },
    })
    expect(denied.status).toBe(403)
    expect((await b.admin.request('GET', path(b.brandId))).json.shadowMode).toBe(false)

    const bad = await owner.request('PATCH', `/api/v1/brands/${b.brandId}/shadow-mode`, {
      body: { shadow_mode: 'yes' },
    })
    expect(bad.status).toBe(400)
    const ok = await owner.request('PATCH', `/api/v1/brands/${b.brandId}/shadow-mode`, {
      body: { shadow_mode: true },
    })
    expect(ok.status).toBe(200)
    expect(ok.json).toEqual({ shadowMode: true })
    expect(actions('brand.shadow_mode_changed', b.brandId)[0]).toMatchObject({
      outcome: 'success',
      detail: { from: false, to: true },
    })
    expect((await b.admin.request('GET', path(b.brandId))).json.shadowMode).toBe(true)
    expect(ownerSecret).toBeTruthy()
  })
})

describe('the kill switch service', () => {
  const deps = () => ({ audit: stack.audit })

  it('an agent switch holds only that agent’s runs', async () => {
    const b = await makeBrand()
    const w = await newJob(b.brandId, 'writer')
    const d = await newJob(b.brandId, 'designer')
    const r = await setSwitch(stack.appPool, deps(), {
      brandId: b.brandId,
      scope: 'agent',
      target: 'writer',
      actor: b.adminId,
    })
    expect(r.held).toBe(1)
    expect(await heldOf([w, d])).toEqual([true, false])
  })

  it('an agent switch for an unknown agent is stored and holds nothing', async () => {
    const b = await makeBrand()
    const w = await newJob(b.brandId, 'writer')
    const r = await setSwitch(stack.appPool, deps(), {
      brandId: b.brandId,
      scope: 'agent',
      target: 'nobody',
      actor: b.adminId,
    })
    expect(r.held).toBe(0)
    expect(r.switch.active).toBe(true)
    expect(await heldOf([w])).toEqual([false])
  })

  it('a channel switch is stored, shown and audited but holds nothing', async () => {
    const b = await makeBrand()
    const w = await newJob(b.brandId, 'writer')
    const r = await setSwitch(stack.appPool, deps(), {
      brandId: b.brandId,
      scope: 'channel',
      target: 'whatsapp',
      actor: b.adminId,
    })
    expect(r.held).toBe(0)
    expect(await heldOf([w])).toEqual([false])
    expect(actions('killswitch.set', b.brandId)[0]?.detail).toMatchObject({
      scope: 'channel',
      target: 'whatsapp',
      held: 0,
    })
    const rows = await stack.db.admin.query(
      'select scope, target, active from app.kill_switch where brand_id = $1',
      [b.brandId],
    )
    expect(rows.rows).toEqual([{ scope: 'channel', target: 'whatsapp', active: true }])
  })

  it('a second identical set is idempotent: same row, no second audit entry', async () => {
    const b = await makeBrand()
    await newJob(b.brandId, 'writer')
    const first = await setSwitch(stack.appPool, deps(), {
      brandId: b.brandId,
      scope: 'brand',
      target: null,
      actor: b.adminId,
    })
    const second = await setSwitch(stack.appPool, deps(), {
      brandId: b.brandId,
      scope: 'brand',
      target: null,
      actor: b.adminId,
    })
    expect(second.switch.id).toBe(first.switch.id)
    expect(second.held).toBe(0)
    expect(actions('killswitch.set', b.brandId)).toHaveLength(1)
    const rows = await stack.db.admin.query(
      'select count(*)::int as n from app.kill_switch where brand_id = $1',
      [b.brandId],
    )
    expect(rows.rows[0].n).toBe(1)
  })

  it('release keeps jobs held that another active switch still covers', async () => {
    const b = await makeBrand()
    const w = await newJob(b.brandId, 'writer')
    const d = await newJob(b.brandId, 'designer')
    const input = { brandId: b.brandId, actor: b.adminId }
    await setSwitch(stack.appPool, deps(), { ...input, scope: 'brand', target: null })
    await setSwitch(stack.appPool, deps(), { ...input, scope: 'agent', target: 'writer' })
    // The agent switch is released while the brand switch is on: nothing is freed.
    const a = await releaseSwitch(stack.appPool, deps(), { ...input, scope: 'agent', target: 'writer' })
    expect(a).toMatchObject({ released: true, unheldJobIds: [] })
    expect(await heldOf([w, d])).toEqual([true, true])
    // The brand switch is released while an agent switch is on: only the other agent's jobs are freed.
    await setSwitch(stack.appPool, deps(), { ...input, scope: 'agent', target: 'writer' })
    const bres = await releaseSwitch(stack.appPool, deps(), { ...input, scope: 'brand', target: null })
    expect(bres.unheldJobIds).toEqual([d])
    expect(await heldOf([w, d])).toEqual([true, false])
    const last = await releaseSwitch(stack.appPool, deps(), { ...input, scope: 'agent', target: 'writer' })
    expect(last.unheldJobIds).toEqual([w])
    expect(await heldOf([w, d])).toEqual([false, false])
  })

  it('releasing a switch that is not active is a no-op', async () => {
    const b = await makeBrand()
    const r = await releaseSwitch(stack.appPool, deps(), {
      brandId: b.brandId,
      scope: 'brand',
      target: null,
      actor: b.adminId,
    })
    expect(r).toEqual({ released: false, unheldJobIds: [] })
    expect(actions('killswitch.released', b.brandId)).toHaveLength(0)
  })

  it('hands the freed job ids to an afterRelease step inside the transaction', async () => {
    const b = await makeBrand()
    const w = await newJob(b.brandId, 'writer')
    const seen: string[][] = []
    const withHook = {
      audit: stack.audit,
      afterRelease: async (_c: unknown, ids: string[]) => void seen.push(ids),
    }
    const input = { brandId: b.brandId, actor: b.adminId, scope: 'brand' as const, target: null }
    await setSwitch(stack.appPool, withHook, input)
    await releaseSwitch(stack.appPool, withHook, input)
    expect(seen).toEqual([[w]])
  })
})

describe('a switch covers jobs created after it, and job start (spec 13)', () => {
  const deps = () => ({ audit: stack.audit })
  const claimsFor = async (jobId: string) => {
    await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
      jobId,
    ])
    const started = await startAttempt(jobs, jobId, 'w1')
    if (started.finished || 'outcome' in started) throw new Error('unexpected')
    const check = verifyAttemptToken(
      jobs.attemptTokenSecret,
      started.token,
      Math.floor(jobs.now().getTime() / 1000),
    )
    if (!check.ok) throw new Error('token')
    return check.claims
  }

  it('a job created after a brand switch is born held: model call and result answer held, flag persisted', async () => {
    const b = await makeBrand()
    await setSwitch(stack.appPool, deps(), {
      brandId: b.brandId,
      scope: 'brand',
      target: null,
      actor: b.adminId,
    })
    const job = await newJob(b.brandId, 'writer')
    expect(await heldOf([job])).toEqual([true])
    const calls = await stack.db.admin.query(
      'select count(*)::int as n from app.model_call where job_id = $1',
      [job],
    )
    expect(calls.rows[0].n).toBe(0)
    const rel = await releaseSwitch(stack.appPool, deps(), {
      brandId: b.brandId,
      scope: 'brand',
      target: null,
      actor: b.adminId,
    })
    expect(rel.unheldJobIds).toEqual([job])
  })

  it('startAttempt on a held job answers held and creates no attempt', async () => {
    const b = await makeBrand()
    const job = await newJob(b.brandId, 'writer')
    await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
      job,
    ])
    await setSwitch(stack.appPool, deps(), {
      brandId: b.brandId,
      scope: 'brand',
      target: null,
      actor: b.adminId,
    })
    expect(await startAttempt(jobs, job, 'w1')).toEqual({ finished: false, outcome: 'held' })
    const n = await stack.db.admin.query('select count(*)::int as n from app.job_attempt where job_id = $1', [
      job,
    ])
    expect(n.rows[0].n).toBe(0)
  })

  it('a switch set after the flag snapshot still holds: a derived hold is persisted, model call and result held', async () => {
    const b = await makeBrand()
    const job = await newJob(b.brandId, 'writer')
    const claims = await claimsFor(job)
    // A switch row inserted behind the service's back (as if its hold had missed this job).
    await stack.db.admin.query(
      `insert into app.kill_switch (brand_id, scope, target, active, set_by) values ($1, 'agent', 'writer', true, $2)`,
      [b.brandId, b.adminId],
    )
    expect(await registerModelCall(jobs, claims, { step: 's', requestHash: 'h', model: 'm' })).toEqual({
      outcome: 'held',
    })
    expect(await heldOf([job])).toEqual([true])
    const posted = await postResult(jobs, claims, { type: 'test.echo', result: {} })
    expect(posted).toEqual({ status: 'held' })
  })

  it('an agent switch covers only that agent’s later jobs', async () => {
    const b = await makeBrand()
    await setSwitch(stack.appPool, deps(), {
      brandId: b.brandId,
      scope: 'agent',
      target: 'writer',
      actor: b.adminId,
    })
    const w = await newJob(b.brandId, 'writer')
    const d = await newJob(b.brandId, 'designer')
    expect(await heldOf([w, d])).toEqual([true, false])
  })

  it('a channel switch covers no later job', async () => {
    const b = await makeBrand()
    await setSwitch(stack.appPool, deps(), {
      brandId: b.brandId,
      scope: 'channel',
      target: 'x',
      actor: b.adminId,
    })
    expect(await heldOf([await newJob(b.brandId, 'writer')])).toEqual([false])
  })

  it('a wrong code on release is audited like on set', async () => {
    const b = await makeBrand()
    stack.audit.entries.length = 0
    const r = await b.admin.request('POST', path(b.brandId, '/release'), {
      body: { scope: 'brand', code: '000000' },
    })
    expect(r.status).toBe(403)
    expect(
      stack.audit.entries.some((e) => e.action === 'auth.second_factor' && e.outcome === 'failure'),
    ).toBe(true)
  })

  it('set racing with release and job creation ends consistent (best effort, repeated)', async () => {
    for (let i = 0; i < 5; i += 1) {
      const b = await makeBrand()
      const input = { brandId: b.brandId, scope: 'brand' as const, target: null, actor: b.adminId }
      await setSwitch(stack.appPool, deps(), input)
      await Promise.all([
        releaseSwitch(stack.appPool, deps(), input),
        setSwitch(stack.appPool, deps(), input),
        newJob(b.brandId, 'writer'),
        newJob(b.brandId, 'writer'),
      ])
      const active = await stack.db.admin.query(
        'select count(*)::int as n from app.kill_switch where brand_id = $1 and active',
        [b.brandId],
      )
      const flags = await stack.db.admin.query('select held from app.job_control where brand_id = $1', [
        b.brandId,
      ])
      if (active.rows[0].n > 0) expect(flags.rows.every((r) => r.held === true)).toBe(true)
      else expect(flags.rows.every((r) => r.held === false)).toBe(true)
    }
  })
})
