import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { agentFilesHash } from '@mkt/db'
import { fileURLToPath } from 'node:url'
import { registerModelCall, saveCheckpoint, startAttempt } from '../src/jobs/service.ts'
import type { JobsDeps } from '../src/jobs/service.ts'
import { verifyAttemptToken } from '../src/jobs/token.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
const dir = (name: string) => fileURLToPath(new URL(`../../../agents/${name}`, import.meta.url))

let stack: Stack
let jobs: JobsDeps
let brandId: string
let ownerId: string
let owner: TestClient
let admin: TestClient
let n = 0

const base = () => `/api/v1/brands/${brandId}/onboarding`
const INTAKE = {
  website: 'https://aztek.example/',
  socials: { instagram: 'https://instagram.com/aztek' },
  competitors: [{ name: 'Rival', website: 'https://rival.example/' }],
}
const q = (sql: string, params: unknown[] = []) => stack.db.admin.query(sql, params)

async function reset(): Promise<void> {
  await q('delete from app.research_source where brand_id = $1', [brandId])
  await q('delete from app.brand_document where brand_id = $1', [brandId])
  await q('update app.onboarding set research_run_id = null, step = $2, intake = null where brand_id = $1', [
    brandId,
    'intake',
  ])
}

async function addDocument(name: string): Promise<string> {
  const made = await q(
    `insert into app.brand_document (brand_id, file_name, media_type, bytes, size_bytes, sha256, uploaded_by)
     values ($1, $2, 'application/pdf', '\\x255044462d', 5, 'h', $3) returning id`,
    [brandId, name, ownerId],
  )
  return made.rows[0].id as string
}

const start = () => owner.request('POST', `${base()}/research`, { body: {} })
const jobRows = async (runId: string) =>
  (
    await q(
      `select job_id, input, class, agent, files_hash from app.job_input where run_id = $1 order by created_at`,
      [runId],
    )
  ).rows

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  brandId = await addBrand(stack, 'research-start')
  ownerId = await addUser(stack, { email: 'owner@rs.test', password: PASSWORD, platformOwner: true })
  await addUser(stack, { email: 'admin@rs.test', password: PASSWORD, role: 'brand_admin', brandId })
  owner = (await enrolledClient(stack, 'owner@rs.test', PASSWORD)).client
  admin = (await enrolledClient(stack, 'admin@rs.test', PASSWORD)).client
  await q(
    `insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, search_micros, source)
     values ('claude-sonnet-5-5', current_date - 30, 4000000, 20000000, 200000, 5000000, 10000, 'test')
     on conflict do nothing`,
  )
  await q(`select app.record_fx_rate(current_date - 1, 83500000, 'test')`)
  for (const agent of ['research', 'research_merge']) {
    await q(
      `insert into app.agent_definition_version (agent, version, model, effort, files_hash, live)
       values ($1, 1, 'claude-sonnet-5-5', 'low', $2, true)`,
      [agent, agentFilesHash(dir(agent))],
    )
  }
}, 120_000)
afterAll(async () => stack?.close())
beforeEach(async () => {
  await q('insert into app.onboarding (brand_id) values ($1) on conflict do nothing', [brandId])
  await reset()
})

describe('intake', () => {
  it('intake is saved and read back', async () => {
    const put = await owner.request('PUT', `${base()}/intake`, { body: INTAKE })
    expect(put.status).toBe(200)
    const got = await owner.request('GET', base())
    expect(got.status).toBe(200)
    expect(got.json).toMatchObject({ step: 'intake', intake: INTAKE, research: null, documents: 0 })
    const audit = await q(`select detail from audit.log where action = 'onboarding.intake_saved'`)
    expect(audit.rows[0].detail).toEqual({ socials: 1, competitors: 1 })
  })

  it('a non-https website is refused 400 naming website', async () => {
    const put = await owner.request('PUT', `${base()}/intake`, {
      body: { ...INTAKE, website: 'http://aztek.example/' },
    })
    expect(put.status).toBe(400)
    expect(JSON.stringify(put.json)).toContain('website')
    const bad = await owner.request('PUT', `${base()}/intake`, {
      body: { ...INTAKE, competitors: [{ name: 'a' }, { name: 'b', website: 'ftp://x.example' }] },
    })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.json)).toContain('competitors.1.website')
  })

  it('the overview of a brand with no onboarding row answers without creating one', async () => {
    const other = await addBrand(stack, 'research-start-empty')
    const got = await owner.request('GET', `/api/v1/brands/${other}/onboarding`)
    expect(got.json).toMatchObject({ step: 'intake', intake: null, research: null, documents: 0 })
    expect((await q('select 1 from app.onboarding where brand_id = $1', [other])).rowCount).toBe(0)
  })
})

describe('starting research', () => {
  it('start without intake is refused 409 intake_needed', async () => {
    const reply = await start()
    expect(reply.status).toBe(409)
    expect(reply.json.error.code).toBe('intake_needed')
  })

  it('starting research creates one job per group and moves the step', async () => {
    await owner.request('PUT', `${base()}/intake`, { body: INTAKE })
    const first = await start()
    expect(first.status).toBe(200)
    const rows = await jobRows(first.json.runId)
    expect(rows.map((r) => r.input.group)).toEqual(['site', 'social', 'visibility', 'competitors'])
    expect(rows.every((r) => r.agent === 'research' && r.class === 'production')).toBe(true)
    expect(rows[0].files_hash).toBe(agentFilesHash(dir('research')))
    expect((await q('select step from app.onboarding where brand_id = $1', [brandId])).rows[0].step).toBe(
      'research',
    )
    // A re-run once the first run is no longer running; now with two documents.
    await q(`update app.run set state = 'succeeded' where id = $1`, [first.json.runId])
    const a = await addDocument('b.pdf')
    const b = await addDocument('a.pdf')
    const second = await start()
    const again = await jobRows(second.json.runId)
    expect(again).toHaveLength(5)
    expect(again[4].input).toMatchObject({ group: 'documents', documentIds: [a, b] })
    const audit = await q(`select detail from audit.log where action = 'onboarding.research_started'`)
    expect(audit.rows.map((r) => r.detail.groups).sort()).toEqual([4, 5])
  })

  it('a second start while running is refused', async () => {
    await owner.request('PUT', `${base()}/intake`, { body: INTAKE })
    expect((await start()).status).toBe(200)
    const second = await start()
    expect(second.status).toBe(409)
    expect(second.json.error.code).toBe('research_running')
  })

  it('without a live research_merge release nothing is created', async () => {
    await owner.request('PUT', `${base()}/intake`, { body: INTAKE })
    await q(`update app.agent_definition_version set live = false where agent = 'research_merge'`)
    const before = (await q(`select count(*)::int as n from app.run where brand_id = $1`, [brandId])).rows[0]
      .n
    const reply = await start()
    await q(`update app.agent_definition_version set live = true where agent = 'research_merge'`)
    expect(reply.status).toBe(503)
    expect(reply.json.error.code).toBe('agent_unavailable')
    expect((await q(`select count(*)::int as n from app.run where brand_id = $1`, [brandId])).rows[0].n).toBe(
      before,
    )
  })
})

async function claimedCall(jobId: string, usage: { searches: number; fetches: number }) {
  await q(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [jobId])
  const started = await startAttempt(jobs, jobId, 'w1')
  if (started.finished || 'outcome' in started) throw new Error('unexpected')
  const check = verifyAttemptToken(
    jobs.attemptTokenSecret,
    started.token,
    Math.floor(jobs.now().getTime() / 1000),
  )
  if (!check.ok) throw new Error('token')
  const step = `s${(n += 1)}`
  const reg = await registerModelCall(jobs, check.claims, {
    step,
    requestHash: 'h',
    model: 'claude-sonnet-5-5',
  })
  if (reg.outcome !== 'send') throw new Error('unexpected')
  await saveCheckpoint(jobs, check.claims, {
    callId: reg.callId,
    step,
    output: { text: 'x' },
    model: 'claude-sonnet-5-5',
    providerMessageId: 'm',
    providerRequestId: null,
    usage: {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      serverToolSearches: usage.searches,
      serverToolFetches: usage.fetches,
    },
  })
}

describe('the overview', () => {
  it("the overview shows each group's state and the running cost", async () => {
    await owner.request('PUT', `${base()}/intake`, { body: INTAKE })
    const { json } = await start()
    const rows = await jobRows(json.runId)
    // site: running (attempt started); social: done; visibility: dead; competitors: waiting.
    await claimedCall(rows[0].job_id, { searches: 1, fetches: 0 })
    await q(
      `update app.job_input set finished_at = now(), outcome = '{"group":"social","sources":[],"findings":[]}' where job_id = $1`,
      [rows[1].job_id],
    )
    await q(`update app.job_control set dead_at = now() where job_id = $1`, [rows[2].job_id])
    const got = (await owner.request('GET', base())).json
    expect(got.research.runId).toBe(json.runId)
    expect(got.research.groups.map((g: { group: string; state: string }) => [g.group, g.state])).toEqual([
      ['site', 'running'],
      ['social', 'done'],
      ['visibility', 'failed'],
      ['competitors', 'waiting'],
    ])
    expect(got.research.merge).toBe('waiting')
    expect(typeof got.cost.usdMicros).toBe('string')
    expect(BigInt(got.cost.usdMicros)).toBeGreaterThan(0n)
  })

  it('a group shows its searches, fetches and cost while running, and its sources once done', async () => {
    await owner.request('PUT', `${base()}/intake`, { body: INTAKE })
    const { json } = await start()
    const rows = await jobRows(json.runId)
    const jobId = rows[0].job_id as string
    await claimedCall(jobId, { searches: 7, fetches: 3 })
    let group = (await owner.request('GET', base())).json.research.groups[0]
    expect(group).toMatchObject({ group: 'site', state: 'running', searches: 7, fetches: 3, sources: [] })
    expect(BigInt(group.cost.usdMicros)).toBeGreaterThanOrEqual(70000n)

    const docId = await addDocument('brochure.pdf')
    const ins = async (kind: string, extract: string, document: string | null, address: string | null) =>
      (
        await q(
          `insert into app.research_source (brand_id, run_id, kind, address, document_id, result, extract)
           values ($1, $2, $3, $4, $5, 'read', $6) returning id`,
          [brandId, json.runId, kind, address, document, extract],
        )
      ).rows[0].id as string
    const s1 = await ins('site', 'About us', null, 'https://aztek.example/about')
    const s2 = await ins('document', '[flagged: odd] text', docId, null)
    // The outcome shape Task 9 writes for a finished group.
    await q(`update app.job_input set finished_at = now(), outcome = $2::jsonb where job_id = $1`, [
      jobId,
      JSON.stringify({
        group: 'site',
        sources: [
          { ref: 's1', id: s1 },
          { ref: 's2', id: s2 },
        ],
        findings: [],
      }),
    ])
    group = (await owner.request('GET', base())).json.research.groups[0]
    expect(group.state).toBe('done')
    expect(group.sources).toEqual([
      {
        id: s1,
        kind: 'site',
        address: 'https://aztek.example/about',
        documentName: null,
        result: 'read',
        flagged: false,
      },
      {
        id: s2,
        kind: 'document',
        address: null,
        documentName: 'brochure.pdf',
        result: 'read',
        flagged: true,
      },
    ])
    expect(JSON.stringify(group)).not.toContain('About us')
  })
})

describe('permissions', () => {
  it('a brand admin gets 403 on all three', async () => {
    const put = await admin.request('PUT', `${base()}/intake`, { body: INTAKE })
    const post = await admin.request('POST', `${base()}/research`, { body: {} })
    const get = await admin.request('GET', base())
    expect([put.status, post.status, get.status]).toEqual([403, 403, 403])
  })
})
