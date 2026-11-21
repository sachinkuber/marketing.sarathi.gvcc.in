import { agentFilesHash, withBrand } from '@mkt/db'
import {
  BASELINE_NEEDED,
  strategistInputSchema,
  type StrategistInput,
  type StrategyBrief,
  type StrategyBriefResult,
} from '@mkt/shared'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerStrategistHandlers } from '../src/agents/register.ts'
import { createVersion, moveState } from '../src/content/versions.ts'
import { postResult, startAttempt, type JobsDeps } from '../src/jobs/service.ts'
import { verifyAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'
import { startStrategist } from '../src/onboarding/brief.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

// Task 6 of M11 (spec 10, test 49): the strategist's brief. Starting it builds the job's input from the brief
// choices' input and the owner's picks; its result becomes the next version of the brand's one strategy_brief item,
// waiting for approval with its facts cited; only the platform owner may decide on it, and approving it completes
// onboarding (gate 1).

const PASSWORD = 'correct horse battery'
const DIR = fileURLToPath(new URL('../../../agents/strategist', import.meta.url))
const TYPE = 'strategy_brief.v1'

let stack: Stack
let jobs: JobsDeps
let ownerId: string
let adminId: string
let approverId: string
let owner: TestClient
let admin: TestClient
let approver: TestClient
let brands = 0

const q = async (sql: string, params: unknown[] = []) => (await stack.db.admin.query(sql, params)).rows
const api = (brandId: string, path = '') => `/api/v1/brands/${brandId}/onboarding${path}`
const contentApi = (brandId: string, path: string) => `/api/v1/brands/${brandId}/content${path}`
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

// A brand whose onboarding is at brief choices, with a profile and one fact the owner confirmed through the API.
// `team` adds a brand admin and an approver to the brand.
async function fresh(
  opts: { step?: string; team?: boolean } = {},
): Promise<{ brandId: string; factId: string }> {
  const brandId = await addBrand(stack, `brief-${(brands += 1)}`)
  await q(`insert into app.onboarding (brand_id, step, intake) values ($1, $2, $3::jsonb)`, [
    brandId,
    opts.step ?? 'brief_choices',
    JSON.stringify({ website: 'https://aztek.example/', socials: {}, competitors: [] }),
  ])
  await q(
    `insert into app.profile_item (brand_id, key, value, status)
     values ($1, 'what_they_sell', '"Ceramic coatings"', 'found')`,
    [brandId],
  )
  if (opts.team) {
    for (const [userId, role] of [
      [adminId, 'brand_admin'],
      [approverId, 'approver'],
    ] as const)
      await q('insert into app.membership (brand_id, user_id, role) values ($1, $2, $3)', [
        brandId,
        userId,
        role,
      ])
  }
  const fact = await owner.request('POST', api(brandId, '/facts'), {
    body: { statement: 'Open since 2019.', reviewDate: day(90) },
  })
  expect(fact.status, JSON.stringify(fact.json)).toBe(200)
  return { brandId, factId: fact.json.factId as string }
}

// A choice as the brief choices result stores it: the first value is the recommended one.
async function addChoice(brandId: string, key: string, values: string[]): Promise<string> {
  const options = values.map((value, i) => ({ value, tradeOff: `Trade-off ${i + 1}.`, recommended: i === 0 }))
  const made = await q(
    `insert into app.suggestion (brand_id, step, key, proposed, why, confidence, options)
     values ($1, 'choice', $2, $3::jsonb, 'It decides the brief.', 'assumed', $4::jsonb) returning id`,
    [brandId, key, JSON.stringify({ question: `Which ${key}?`, value: values[0] }), JSON.stringify(options)],
  )
  return made[0].id as string
}
const decide = async (brandId: string, suggestionId: string, body: unknown) => {
  const reply = await owner.request('POST', api(brandId, `/suggestions/${suggestionId}/decision`), { body })
  expect(reply.status, JSON.stringify(reply.json)).toBe(200)
}
const LEAD = ['Owners of new cars', 'Fleet managers', 'Detailing studios']
// The lead audience, accepted: the brief's choicesMade below names it.
async function settle(brandId: string): Promise<void> {
  await decide(brandId, await addChoice(brandId, 'lead_audience', LEAD), { decision: 'accepted' })
}

const start = (brandId: string) => owner.request('POST', api(brandId, '/brief'), { body: {} })
async function started(brandId: string): Promise<{ runId: string; jobId: string; revision: number }> {
  const reply = await start(brandId)
  expect(reply.status, JSON.stringify(reply.json)).toBe(200)
  return reply.json as { runId: string; jobId: string; revision: number }
}
const inputOf = async (jobId: string): Promise<StrategistInput> =>
  (await q('select input from app.job_input where job_id = $1', [jobId]))[0].input

async function claim(jobId: string): Promise<AttemptClaims> {
  await q(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [jobId])
  const begun = await startAttempt(jobs, jobId, 'w1')
  if (begun.finished || 'outcome' in begun) throw new Error('unexpected')
  const check = verifyAttemptToken(
    jobs.attemptTokenSecret,
    begun.token,
    Math.floor(jobs.now().getTime() / 1000),
  )
  if (!check.ok) throw new Error('token')
  return check.claims
}

const brief = (factIds: string[], statement = 'The coating people of Pune.'): StrategyBrief => ({
  positioning: { statement, paragraph: 'Ceramic coatings that keep a new car new.' },
  audiences: [
    {
      name: 'New car owners',
      needs: 'A shine that lasts.',
      message: 'Coat it once, enjoy it for years.',
      where: 'Instagram',
    },
  ],
  themes: ['Care', 'Proof', 'Process', 'People'].map((name) => ({
    name,
    why: `${name} builds trust.`,
    topics: [`${name} one`, `${name} two`],
  })),
  channels: [{ channel: 'Instagram', audiences: ['New car owners'], why: 'They look for cars there.' }],
  cadence: [{ channel: 'Instagram', postsPerWeek: 3 }],
  goals: [{ metric: 'Enquiries a month', from: BASELINE_NEEDED, to: '20' }],
  choicesMade: [{ key: 'lead_audience', picked: 'Owners of new cars', notTaken: ['Fleet managers'] }],
  factIds,
})
const result = (factIds: string[], statement?: string): StrategyBriefResult => ({
  brief: brief(factIds, statement),
  ask: null,
})
const post = async (jobId: string, body: unknown) =>
  postResult(jobs, await claim(jobId), { type: TYPE, result: body })

// The brand's brief item and its current version.
async function currentBrief(brandId: string) {
  const rows = await q(
    `select i.id as item_id, v.id as version_id, v.hash, s.state
       from app.content_item i
       join app.content_version v on v.id = i.current_version_id
       join app.content_version_state s on s.content_version_id = v.id
      where i.brand_id = $1 and i.kind = 'strategy_brief'`,
    [brandId],
  )
  expect(rows).toHaveLength(1)
  return {
    itemId: rows[0].item_id as string,
    versionId: rows[0].version_id as string,
    hash: rows[0].hash as string,
    state: rows[0].state as string,
  }
}
const stateOf = async (versionId: string) =>
  (await q('select state from app.content_version_state where content_version_id = $1', [versionId]))[0]
    .state as string
const stepOf = async (brandId: string) =>
  (await q('select step from app.onboarding where brand_id = $1', [brandId]))[0].step as string
const overview = async (brandId: string) => {
  const reply = await owner.request('GET', api(brandId))
  expect(reply.status).toBe(200)
  return reply.json
}
// A brand with a brief waiting for approval.
async function withBrief(opts: { team?: boolean } = {}) {
  const made = await fresh(opts)
  await settle(made.brandId)
  const { runId, jobId } = await started(made.brandId)
  await post(jobId, result([made.factId]))
  return { ...made, runId, ...(await currentBrief(made.brandId)) }
}

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  registerStrategistHandlers(jobs.results, jobs)
  ownerId = await addUser(stack, { email: 'owner@brief.test', password: PASSWORD, platformOwner: true })
  const home = await addBrand(stack, 'brief-team')
  adminId = await addUser(stack, {
    email: 'admin@brief.test',
    password: PASSWORD,
    role: 'brand_admin',
    brandId: home,
  })
  approverId = await addUser(stack, {
    email: 'approver@brief.test',
    password: PASSWORD,
    role: 'approver',
    brandId: home,
  })
  owner = (await enrolledClient(stack, 'owner@brief.test', PASSWORD)).client
  admin = (await enrolledClient(stack, 'admin@brief.test', PASSWORD)).client
  approver = (await enrolledClient(stack, 'approver@brief.test', PASSWORD)).client
  await q(
    `insert into app.agent_definition_version (agent, version, model, effort, files_hash, live)
     values ('strategist', 1, 'claude-sonnet-5-5', 'medium', $1, true)`,
    [agentFilesHash(DIR)],
  )
}, 120_000)
afterAll(async () => stack?.close())

describe('the strategy brief', () => {
  it('starting the brief builds the picks with the options not taken', async () => {
    const { brandId, factId } = await fresh()
    // An earlier lead audience the owner settled; the later decision on the same key is the one that counts.
    const earlier = await addChoice(brandId, 'lead_audience', LEAD)
    await decide(brandId, earlier, { decision: 'edited', value: { value: 'Fleet managers' } })
    const lead = await addChoice(brandId, 'lead_audience', LEAD)
    const angle = await addChoice(brandId, 'positioning_angle', ['Long-lasting shine', 'Care for your car'])
    const channels = await addChoice(brandId, 'first_channels', [
      'Instagram',
      'Google Business Profile',
      'Facebook',
    ])
    // A superseded choice is neither open nor a pick.
    const dropped = await addChoice(brandId, 'content_focus', ['How-to videos', 'Customer stories'])
    await q('update app.suggestion set superseded_by = $2 where id = $1', [dropped, lead])
    await decide(brandId, lead, { decision: 'accepted' })
    await decide(brandId, angle, { decision: 'edited', value: { value: 'Care for your car' } })
    await decide(brandId, channels, { decision: 'edited', value: { value: 'Only WhatsApp, daily' } })

    const { runId, jobId, revision } = await started(brandId)
    expect(revision).toBe(0)
    expect((await q('select agent, state from app.run where id = $1', [runId]))[0]).toEqual({
      agent: 'strategist',
      state: 'running',
    })
    expect(
      (await q('select class, agent, expected_result_type from app.job_input where job_id = $1', [jobId]))[0],
    ).toEqual({ class: 'production', agent: 'strategist', expected_result_type: TYPE })
    const input = await inputOf(jobId)
    expect(() => strategistInputSchema.parse(input)).not.toThrow()
    expect(input.picks).toEqual([
      {
        key: 'lead_audience',
        question: 'Which lead_audience?',
        picked: 'Owners of new cars',
        notTaken: ['Fleet managers', 'Detailing studios'],
      },
      {
        key: 'positioning_angle',
        question: 'Which positioning_angle?',
        picked: 'Care for your car',
        notTaken: ['Long-lasting shine'],
      },
      {
        key: 'first_channels',
        question: 'Which first_channels?',
        picked: 'Only WhatsApp, daily',
        notTaken: ['Instagram', 'Google Business Profile'],
      },
    ])
    // The brief choices' part of the input, then today, no baseline and no change request.
    expect(input.brandName).toBe((await q('select name from app.brand where id = $1', [brandId]))[0].name)
    expect(input.profile).toEqual([{ key: 'what_they_sell', value: 'Ceramic coatings', status: 'found' }])
    expect(input.facts).toEqual([{ id: factId, statement: 'Open since 2019.' }])
    expect(input.today).toBe(jobs.now().toISOString().slice(0, 10))
    expect(input.baseline).toBeNull()
    expect(input.changeRequest).toBeNull()
    const audit = await q(
      `select detail from audit.log where action = 'onboarding.brief_started' and brand_id = $1`,
      [brandId],
    )
    expect(audit.map((r) => r.detail)).toEqual([{ runId, revision: 0 }])
  })

  it('the brief is refused while a choice is undecided', async () => {
    const noRun = async (brandId: string) =>
      expect(
        (await q(`select 1 from app.run where brand_id = $1 and agent = 'strategist'`, [brandId])).length,
      ).toBe(0)
    const refused = async (brandId: string, status: number, code: string) => {
      const reply = await start(brandId)
      expect(reply.status, code).toBe(status)
      expect(reply.json).toMatchObject({ error: { code } })
      await noRun(brandId)
    }
    const early = await fresh({ step: 'facts_rules' })
    await settle(early.brandId)
    await refused(early.brandId, 409, 'brief_choices_needed')

    const open = await fresh()
    await settle(open.brandId)
    await addChoice(open.brandId, 'goal_focus', ['More calls', 'More visits'])
    await refused(open.brandId, 409, 'choices_open')

    await refused((await fresh()).brandId, 409, 'choices_needed')

    // Every fact retired since the choices were made: the brief would rest on nothing.
    const bare = await fresh()
    await settle(bare.brandId)
    const retired = await owner.request('POST', api(bare.brandId, `/facts/${bare.factId}/retire`), {
      body: {},
    })
    expect(retired.status).toBe(200)
    await refused(bare.brandId, 409, 'facts_needed')

    const down = await fresh()
    await settle(down.brandId)
    await q(`update app.agent_definition_version set live = false where agent = 'strategist'`)
    try {
      await refused(down.brandId, 503, 'agent_unavailable')
    } finally {
      await q(`update app.agent_definition_version set live = true where agent = 'strategist'`)
    }

    const twice = await fresh()
    await settle(twice.brandId)
    await started(twice.brandId)
    const again = await start(twice.brandId)
    expect(again.status).toBe(409)
    expect(again.json).toMatchObject({ error: { code: 'brief_running' } })
  })

  it('the result becomes a version awaiting approval, with fact_refs and a facts_current check', async () => {
    const { brandId, factId } = await fresh()
    await settle(brandId)
    const { runId, jobId } = await started(brandId)
    await post(jobId, result([factId]))

    const items = await q('select id, kind from app.content_item where brand_id = $1', [brandId])
    expect(items).toEqual([{ id: expect.any(String), kind: 'strategy_brief' }])
    const versions = await q(
      `select id, number, payload_canonical, provenance, created_by_kind, created_by_run
         from app.content_version where content_item_id = $1`,
      [items[0].id],
    )
    expect(versions).toHaveLength(1)
    const version = versions[0]
    expect(version).toMatchObject({
      number: 1,
      provenance: { source: 'strategist', revision: 0 },
      created_by_kind: 'agent',
      created_by_run: runId,
    })
    const hash = (await q('select fact_hash from app.verified_fact where id = $1', [factId]))[0].fact_hash
    const payload = JSON.parse(version.payload_canonical)
    expect(payload.fact_refs).toEqual([{ fact_id: factId, text_hash: `sha256:${hash}` }])
    const name = (await q('select name from app.brand where id = $1', [brandId]))[0].name
    expect(payload).toMatchObject({
      kind: 'strategy_brief',
      title: `Strategy brief: ${name}`,
      summary: 'The coating people of Pune.',
    })
    expect(await stateOf(version.id)).toBe('awaiting_approval')
    // One transaction, so one timestamp: the moves are compared as a set.
    const moves = await q(
      `select from_state, to_state, actor_kind, actor_id from app.content_version_state_change
        where content_version_id = $1`,
      [version.id],
    )
    expect(moves).toHaveLength(3)
    expect(moves).toEqual(
      expect.arrayContaining([
        { from_state: null, to_state: 'draft', actor_kind: 'agent', actor_id: runId },
        { from_state: 'draft', to_state: 'in_checks', actor_kind: 'agent', actor_id: runId },
        { from_state: 'in_checks', to_state: 'awaiting_approval', actor_kind: 'agent', actor_id: runId },
      ]),
    )
    expect(
      await q('select check_name, kind, passed from app.check_result where content_version_id = $1', [
        version.id,
      ]),
    ).toEqual([{ check_name: 'facts_current', kind: 'blocking', passed: true }])
    expect(
      (await q('select closed_at from app.approval_request where content_version_id = $1', [version.id]))[0],
    ).toEqual({ closed_at: null })
    expect(await stepOf(brandId)).toBe('brief')
    const seen = await overview(brandId)
    expect(seen.brief).toEqual({
      itemId: items[0].id,
      versionId: version.id,
      number: 1,
      state: 'awaiting_approval',
      revision: 0,
      needsDecision: false,
      job: { state: 'done' },
    })
    expect(seen.gate1).toBe(false)

    // A result that asks is refused and stores nothing.
    const other = await fresh()
    await settle(other.brandId)
    const second = await started(other.brandId)
    const ask = { text: 'Which city first?', why: 'Two answers differ.', options: [], suggested: null }
    await expect(
      postResult(jobs, await claim(second.jobId), { type: TYPE, result: { brief: null, ask } }),
    ).rejects.toMatchObject({ status: 422, code: 'result_invalid' })
    expect(await q('select 1 from app.content_item where brand_id = $1', [other.brandId])).toEqual([])
    expect((await overview(other.brandId)).brief).toBeNull()
  })

  it('a brief citing an unknown or inactive fact is refused', async () => {
    const nothingWritten = async (brandId: string) => {
      expect(await q('select 1 from app.content_item where brand_id = $1', [brandId])).toEqual([])
      expect(await stepOf(brandId)).toBe('brief_choices')
    }
    // An id that is no fact of the brand, beside one that is.
    const a = await fresh()
    await settle(a.brandId)
    const first = await started(a.brandId)
    await expect(post(first.jobId, result([a.factId, randomUUID()]))).rejects.toMatchObject({
      status: 422,
      code: 'unknown_fact',
    })
    await nothingWritten(a.brandId)

    // Another brand's fact.
    const b = await fresh()
    await settle(b.brandId)
    const second = await started(b.brandId)
    await expect(post(second.jobId, result([a.factId]))).rejects.toMatchObject({
      status: 422,
      code: 'unknown_fact',
    })
    await nothingWritten(b.brandId)

    // A fact of the job's input, retired since the job started (test 49).
    const c = await fresh()
    await settle(c.brandId)
    const third = await started(c.brandId)
    const retired = await owner.request('POST', api(c.brandId, `/facts/${c.factId}/retire`), { body: {} })
    expect(retired.status).toBe(200)
    await expect(post(third.jobId, result([c.factId]))).rejects.toMatchObject({
      status: 422,
      code: 'unknown_fact',
    })
    await nothingWritten(c.brandId)
  })

  it('a second brief supersedes the waiting one', async () => {
    const first = await withBrief()
    const { jobId } = await started(first.brandId)
    await post(jobId, result([first.factId], 'A sharper line.'))
    const second = await currentBrief(first.brandId)
    expect(second.itemId).toBe(first.itemId)
    expect(second.versionId).not.toBe(first.versionId)
    expect(
      await q('select number from app.content_version where content_item_id = $1 order by number', [
        first.itemId,
      ]),
    ).toEqual([{ number: 1 }, { number: 2 }])
    expect(await stateOf(first.versionId)).toBe('superseded')
    expect(second.state).toBe('awaiting_approval')
    const closed = async (versionId: string) =>
      (await q('select closed_at from app.approval_request where content_version_id = $1', [versionId]))[0]
        .closed_at !== null
    expect(await closed(first.versionId)).toBe(true)
    expect(await closed(second.versionId)).toBe(false)
    expect((await overview(first.brandId)).brief).toMatchObject({ versionId: second.versionId, number: 2 })
  })

  it('a change request carries the comment and the previous brief, and its version is the next revision', async () => {
    const first = await withBrief()
    const asked = await startStrategist(stack.appPool, jobs, {
      brandId: first.brandId,
      actor: { userId: ownerId },
      changeRequest: { comment: 'Lead with fleets.', previousVersionId: first.versionId },
    })
    expect(asked.revision).toBe(1)
    const input = await inputOf(asked.jobId)
    expect(() => strategistInputSchema.parse(input)).not.toThrow()
    expect(input.changeRequest?.comment).toBe('Lead with fleets.')
    // The previous brief as plain text: its headings, paragraphs and items, one per line.
    const lines = input.changeRequest!.previous.split('\n')
    expect(lines.slice(0, 4)).toEqual([
      'Positioning',
      'Ceramic coatings that keep a new car new.',
      'Audiences',
      'New car owners',
    ])
    expect(lines).toContain('Needs: A shine that lasts.')
    expect(lines.at(-2)).toBe('Facts used')
    expect(lines.at(-1)).toBe('Open since 2019.')
    expect(
      (
        await q(
          `select detail from audit.log where action = 'onboarding.brief_started' and brand_id = $1 order by seq`,
          [first.brandId],
        )
      ).map((r) => r.detail),
    ).toEqual([
      { runId: first.runId, revision: 0 },
      { runId: asked.runId, revision: 1 },
    ])
    await post(asked.jobId, result([first.factId], 'Fleets first.'))
    const next = await currentBrief(first.brandId)
    expect(
      (await q('select provenance from app.content_version where id = $1', [next.versionId]))[0].provenance,
    ).toEqual({ source: 'strategist', revision: 1 })
    expect((await overview(first.brandId)).brief).toMatchObject({
      number: 2,
      revision: 1,
      needsDecision: false,
    })
    // A change request names the brief's latest version: an earlier one is refused before anything is written.
    const runs = await q(`select id from app.run where brand_id = $1 order by id`, [first.brandId])
    await expect(
      startStrategist(stack.appPool, jobs, {
        brandId: first.brandId,
        actor: { userId: ownerId },
        changeRequest: { comment: 'Lead with fleets.', previousVersionId: first.versionId },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'not_current_version' })
    expect(await q(`select id from app.run where brand_id = $1 order by id`, [first.brandId])).toEqual(runs)
  })

  it('the overview says a brief closed by a change request at the revision limit needs a decision', async () => {
    const first = await withBrief()
    const closeAt = async (revision: number) =>
      withBrand(stack.appPool, first.brandId, async (client) => {
        const actor = { kind: 'agent' as const, runId: first.runId }
        const made = await createVersion(client, jobs, {
          brandId: first.brandId,
          contentItemId: first.itemId,
          payload: {
            kind: 'strategy_brief',
            language: 'en',
            body: [{ type: 'paragraph', text: `Rev ${revision}` }],
          },
          createdBy: actor,
          provenance: { source: 'strategist', revision },
        })
        await moveState(client, jobs, made.versionId, 'in_checks', actor)
        await moveState(client, jobs, made.versionId, 'awaiting_approval', actor)
        await client.query(
          `insert into app.approval (brand_id, content_version_id, version_hash, hash_scheme, decision, decided_by, comment)
           values ($1, $2, $3, 'cv1', 'changes_requested', $4, 'Again.')`,
          [first.brandId, made.versionId, made.hash, ownerId],
        )
        await moveState(
          client,
          jobs,
          made.versionId,
          'rejected',
          { kind: 'user', userId: ownerId },
          'changes_requested',
        )
      })
    await closeAt(2)
    expect((await overview(first.brandId)).brief).toMatchObject({
      state: 'rejected',
      revision: 2,
      needsDecision: false,
    })
    await closeAt(3)
    const seen = await overview(first.brandId)
    expect(seen.brief).toMatchObject({ state: 'rejected', revision: 3, needsDecision: true })
    expect(seen.gate1).toBe(false)
  })

  it('only platform owners are asked to approve a brief', async () => {
    const made = await withBrief({ team: true })
    const told = async (versionId: string) =>
      (
        await q(
          `select user_id from app.notification
            where brand_id = $1 and kind = 'approval_waiting' and subject_id = $2 order by user_id`,
          [made.brandId, versionId],
        )
      ).map((r) => r.user_id as string)
    const owners = (await q('select app.platform_owner_ids() as id order by 1')).map((r) => r.id as string)
    expect(await told(made.versionId)).toEqual([...owners].sort())
    expect(await told(made.versionId)).toContain(ownerId)
    expect(await told(made.versionId)).not.toContain(adminId)
    expect(await told(made.versionId)).not.toContain(approverId)

    // Any other kind in the same brand still asks its approvers and admins.
    const article = (
      await q(`insert into app.content_item (brand_id, kind) values ($1, 'article') returning id`, [
        made.brandId,
      ])
    )[0].id as string
    const versionId = await withBrand(stack.appPool, made.brandId, async (client) => {
      const actor = { kind: 'user' as const, userId: ownerId }
      const v = await createVersion(client, jobs, {
        brandId: made.brandId,
        contentItemId: article,
        payload: { kind: 'article', language: 'en', body: [{ type: 'paragraph', text: 'Hello' }] },
        createdBy: actor,
      })
      await moveState(client, jobs, v.versionId, 'in_checks', actor)
      await moveState(client, jobs, v.versionId, 'awaiting_approval', actor)
      return v.versionId
    })
    expect(await told(versionId)).toEqual([adminId, approverId].sort())
  })

  it('a brand admin cannot decide on a strategy brief', async () => {
    const made = await withBrief({ team: true })
    const base = contentApi(made.brandId, `/${made.itemId}/versions/${made.versionId}`)
    for (const who of [admin, approver]) {
      const approved = await who.request('POST', `${base}/approve`, {
        body: { hash: made.hash, hash_scheme: 'cv1' },
      })
      expect(approved.status).toBe(403)
      expect(approved.json).toMatchObject({ error: { code: 'forbidden' } })
      const rejected = await who.request('POST', `${base}/reject`, { body: { reason: 'Not for us.' } })
      expect(rejected.status).toBe(403)
      expect(rejected.json).toMatchObject({ error: { code: 'forbidden' } })
    }
    expect(await stateOf(made.versionId)).toBe('awaiting_approval')
    expect(await q('select 1 from app.approval where content_version_id = $1', [made.versionId])).toEqual([])
    // Each refusal is audited as one, with its code only.
    const refusals = await q(
      `select action, outcome, actor_id, detail from audit.log
        where brand_id = $1 and subject = $2 and action in ('approval.approved', 'approval.rejected') order by seq`,
      [made.brandId, made.versionId],
    )
    expect(refusals).toEqual(
      [adminId, approverId].flatMap((userId) => [
        { action: 'approval.approved', outcome: 'failure', actor_id: userId, detail: { code: 'forbidden' } },
        { action: 'approval.rejected', outcome: 'failure', actor_id: userId, detail: { code: 'forbidden' } },
      ]),
    )
    // The same people still decide on the brand's other content: only the brief is the platform owner's.
    const article = (
      await q(`insert into app.content_item (brand_id, kind) values ($1, 'article') returning id`, [
        made.brandId,
      ])
    )[0].id as string
    const other = await withBrand(stack.appPool, made.brandId, async (client) => {
      const actor = { kind: 'user' as const, userId: ownerId }
      const v = await createVersion(client, jobs, {
        brandId: made.brandId,
        contentItemId: article,
        payload: { kind: 'article', language: 'en', body: [{ type: 'paragraph', text: 'Hello' }] },
        createdBy: actor,
      })
      await moveState(client, jobs, v.versionId, 'in_checks', actor)
      await moveState(client, jobs, v.versionId, 'awaiting_approval', actor)
      return v
    })
    const fine = await admin.request(
      'POST',
      contentApi(made.brandId, `/${article}/versions/${other.versionId}/approve`),
      {
        body: { hash: other.hash, hash_scheme: 'cv1' },
      },
    )
    expect(fine.status, JSON.stringify(fine.json)).toBe(201)
  })

  it('approving the brief completes onboarding and passes gate 1', async () => {
    const made = await withBrief()
    const approve = (versionId: string, hash: string) =>
      owner.request('POST', contentApi(made.brandId, `/${made.itemId}/versions/${versionId}/approve`), {
        body: { hash, hash_scheme: 'cv1' },
      })
    const approved = await approve(made.versionId, made.hash)
    expect(approved.status, JSON.stringify(approved.json)).toBe(201)
    expect(await stateOf(made.versionId)).toBe('approved')
    const ob = await q('select step, completed_at from app.onboarding where brand_id = $1', [made.brandId])
    expect(ob[0].step).toBe('done')
    expect(ob[0].completed_at).not.toBeNull()
    const passed = async () =>
      (
        await q(
          `select detail from audit.log where action = 'onboarding.gate_passed' and brand_id = $1 order by seq`,
          [made.brandId],
        )
      ).map((r) => r.detail)
    expect(await passed()).toEqual([{ versionId: made.versionId }])
    let seen = await overview(made.brandId)
    expect(seen.step).toBe('done')
    expect(seen.brief).toMatchObject({ versionId: made.versionId, state: 'approved' })
    expect(seen.gate1).toBe(true)

    // A new brief after onboarding is done waits without moving the step back; approving it passes the gate again.
    const { jobId } = await started(made.brandId)
    await post(jobId, result([made.factId], 'A sharper line.'))
    const next = await currentBrief(made.brandId)
    expect(await stateOf(made.versionId)).toBe('superseded')
    expect(await stepOf(made.brandId)).toBe('done')
    seen = await overview(made.brandId)
    expect(seen.gate1).toBe(false)
    expect((await approve(next.versionId, next.hash)).status).toBe(201)
    expect(await stepOf(made.brandId)).toBe('done')
    expect(await passed()).toEqual([{ versionId: made.versionId }, { versionId: next.versionId }])
    expect((await overview(made.brandId)).gate1).toBe(true)
  })

  it('the platform owner rejects a brief and the step stays brief', async () => {
    const made = await withBrief()
    const rejected = await owner.request(
      'POST',
      contentApi(made.brandId, `/${made.itemId}/versions/${made.versionId}/reject`),
      { body: { reason: 'Not the direction we want.' } },
    )
    expect(rejected.status, JSON.stringify(rejected.json)).toBe(201)
    expect(await stateOf(made.versionId)).toBe('rejected')
    expect(await stepOf(made.brandId)).toBe('brief')
    const seen = await overview(made.brandId)
    expect(seen.brief).toMatchObject({ versionId: made.versionId, state: 'rejected', needsDecision: false })
    expect(seen.gate1).toBe(false)
    expect(
      await q(`select 1 from audit.log where action = 'onboarding.gate_passed' and brand_id = $1`, [
        made.brandId,
      ]),
    ).toEqual([])
  })

  it('approving a brief while onboarding is at another step passes no gate', async () => {
    const made = await withBrief()
    // Not reachable through the routes; the approval must not claim a gate it did not pass.
    await q(`update app.onboarding set step = 'brief_choices' where brand_id = $1`, [made.brandId])
    const approved = await owner.request(
      'POST',
      contentApi(made.brandId, `/${made.itemId}/versions/${made.versionId}/approve`),
      { body: { hash: made.hash, hash_scheme: 'cv1' } },
    )
    expect(approved.status, JSON.stringify(approved.json)).toBe(201)
    expect(await stepOf(made.brandId)).toBe('brief_choices')
    expect(
      await q(`select 1 from audit.log where action = 'onboarding.gate_passed' and brand_id = $1`, [
        made.brandId,
      ]),
    ).toEqual([])
  })

  it('an edit of a brief is refused', async () => {
    const made = await withBrief()
    const reply = await owner.request('POST', contentApi(made.brandId, `/${made.itemId}/versions`), {
      body: {
        kind: 'strategy_brief',
        language: 'en',
        title: 'Mine',
        body: [{ type: 'paragraph', text: 'My own.' }],
      },
    })
    expect(reply.status).toBe(409)
    expect(reply.json).toMatchObject({
      error: {
        code: 'ask_for_changes_instead',
        message: 'A brief is changed by asking for changes, not by editing it.',
      },
    })
    expect(
      await q('select 1 from app.content_version where content_item_id = $1', [made.itemId]),
    ).toHaveLength(1)
    expect(await stateOf(made.versionId)).toBe('awaiting_approval')
  })
})
