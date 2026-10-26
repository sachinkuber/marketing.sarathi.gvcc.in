import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startSummaryRun } from '../src/agents/start.ts'
import type { JobsDeps } from '../src/jobs/service.ts'
import type { AuditEntry, AuditSink } from '../src/ports.ts'
import { BRIEF } from './summary-support.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'

let stack: Stack
let jobs: JobsDeps
let brand: string
let ownerId: string
let owner: TestClient
const others: Record<string, TestClient> = {}

const route = () => `/api/v1/brands/${brand}/agents/summary/runs`
const runCount = async (): Promise<number> =>
  (await stack.db.admin.query('select count(*)::int as n from app.run where brand_id = $1', [brand])).rows[0]
    .n

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  brand = await addBrand(stack, 'start-a')
  ownerId = await addUser(stack, { email: 'owner@start.test', password: PASSWORD, platformOwner: true })
  for (const role of ['viewer', 'approver', 'brand_admin'] as const) {
    await addUser(stack, { email: `${role}@start.test`, password: PASSWORD, role, brandId: brand })
    others[role] = (await enrolledClient(stack, `${role}@start.test`, PASSWORD)).client
  }
  owner = (await enrolledClient(stack, 'owner@start.test', PASSWORD)).client
}, 120_000)
afterAll(async () => {
  await stack?.close()
})

describe('starting a summary run', () => {
  it('refuses a brief over 2000 characters before any run exists', async () => {
    const reply = await owner.request('POST', route(), { body: { brief: 'a'.repeat(2001) } })
    expect(reply.status).toBe(400)
    expect(await runCount()).toBe(0)
  })

  it('refuses a brief with an invisible character, a blank one and an unknown field', async () => {
    for (const body of [{ brief: `hello‮world` }, { brief: '   ' }, { brief: BRIEF, extra: 1 }, {}]) {
      const reply = await owner.request('POST', route(), { body })
      expect(reply.status).toBe(400)
    }
    expect(await runCount()).toBe(0)
  })

  it('refuses a viewer, an approver and a brand admin; only the platform owner may start it', async () => {
    for (const role of ['viewer', 'approver', 'brand_admin']) {
      const reply = await others[role]!.request('POST', route(), { body: { brief: BRIEF } })
      expect(reply.status, role).toBe(403)
    }
    expect(await runCount()).toBe(0)
  })

  it('starts a run, a job, its input and an audit entry that never carries the brief text', async () => {
    const reply = await owner.request('POST', route(), { body: { brief: BRIEF } })
    expect(reply.status).toBe(201)
    const { runId, jobId } = reply.json as { runId: string; jobId: string }
    const run = await stack.db.admin.query(
      `select r.agent, r.state, r.started_by_kind, r.started_by_id, d.agent as def_agent, d.live
         from app.run r join app.agent_definition_version d on d.id = r.definition_version_id where r.id = $1`,
      [runId],
    )
    expect(run.rows[0]).toMatchObject({
      agent: 'summary',
      state: 'running',
      started_by_kind: 'user',
      started_by_id: ownerId,
      def_agent: 'summary',
      live: true,
    })
    const input = await stack.db.admin.query(
      'select class, input, expected_result_type, run_id from app.job_input where job_id = $1',
      [jobId],
    )
    expect(input.rows[0]).toMatchObject({
      class: 'interactive',
      input: { brief: BRIEF },
      expected_result_type: 'summary.v1',
      run_id: runId,
    })
    expect(await jobs.queue.state('interactive', jobId)).not.toBeNull()
    const logged = await stack.db.admin.query(
      `select detail, brand_id from audit.log where action = 'agent.run_started' and subject = $1`,
      [runId],
    )
    expect(logged.rowCount).toBe(1)
    expect(logged.rows[0].detail).toEqual({ runId, jobId, briefLength: BRIEF.length })
    expect(JSON.stringify(logged.rows[0].detail)).not.toContain('monsoon')
  })

  it('leaves nothing behind when a step after createJob fails (one transaction)', async () => {
    const before = await stack.db.admin.query(
      `select (select count(*)::int from app.run where brand_id = $1) as runs,
              (select count(*)::int from app.job_input where brand_id = $1) as inputs,
              (select count(*)::int from app.job_control where brand_id = $1) as controls`,
      [brand],
    )
    const failing: AuditSink = {
      async record(entry: AuditEntry, tx) {
        if (entry.action === 'agent.run_started') throw new Error('audit down')
        await jobs.audit.record(entry, tx)
      },
    }
    const queued = () =>
      stack.db.admin.query(`select count(*)::int as n from pgboss.job where name = 'job-interactive'`)
    const entries = () =>
      stack.db.admin.query(`select count(*)::int as n from audit.log where action = 'agent.run_started'`)
    const [queueBefore, auditBefore] = [(await queued()).rows[0].n, (await entries()).rows[0].n]
    await expect(
      startSummaryRun(
        jobs.pool,
        { ...jobs, audit: failing },
        { brandId: brand, brief: BRIEF, actor: { userId: ownerId } },
      ),
    ).rejects.toThrow('audit down')
    const after = await stack.db.admin.query(
      `select (select count(*)::int from app.run where brand_id = $1) as runs,
              (select count(*)::int from app.job_input where brand_id = $1) as inputs,
              (select count(*)::int from app.job_control where brand_id = $1) as controls`,
      [brand],
    )
    expect(after.rows[0]).toEqual(before.rows[0])
    expect((await queued()).rows[0].n).toBe(queueBefore)
    expect((await entries()).rows[0].n).toBe(auditBefore)
  })

  it('answers 503 agent_unavailable when no summary definition is live, and writes nothing', async () => {
    await stack.db.admin.query(`update app.agent_definition_version set live = false where agent = 'summary'`)
    try {
      const runs = await runCount()
      const reply = await owner.request('POST', route(), { body: { brief: BRIEF } })
      expect(reply.status).toBe(503)
      expect(reply.json.error.code).toBe('agent_unavailable')
      expect(await runCount()).toBe(runs)
    } finally {
      await stack.db.admin.query(
        `update app.agent_definition_version set live = true where agent = 'summary'`,
      )
    }
  })

  it('refuses a brief the service itself finds invalid, whoever calls it', async () => {
    await expect(
      startSummaryRun(jobs.pool, jobs, {
        brandId: brand,
        brief: 'x'.repeat(2001),
        actor: { userId: ownerId },
      }),
    ).rejects.toMatchObject({ status: 400 })
  })
})
