import { agentFilesHash } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import {
  briefChoicesInputSchema,
  CHOICE_KEYS,
  type BriefChoicesInput,
  type BriefChoicesResult,
} from '@mkt/shared'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerBriefChoicesHandlers } from '../src/agents/register.ts'
import { postResult, startAttempt, type JobsDeps } from '../src/jobs/service.ts'
import { verifyAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

// Task 5 of M11 (spec 4, 6): the core side of the brief choices. The job's input is built from the profile, the
// active facts, the active rules and the finished questionnaire's answers; its result becomes choice suggestions;
// the owner picks one option or writes their own. A choice is neither a fact nor a rule.

const PASSWORD = 'correct horse battery'
const DIR = fileURLToPath(new URL('../../../agents/brief_choices', import.meta.url))
const FR_DIR = fileURLToPath(new URL('../../../agents/facts_rules', import.meta.url))
const TYPE = 'brief_choices.v1'

let stack: Stack
let jobs: JobsDeps
let definitionId: string
let ownerId: string
let owner: TestClient
let admin: TestClient
let adminBrand: string
let brands = 0

const q = async (sql: string, params: unknown[] = []) => (await stack.db.admin.query(sql, params)).rows
const api = (brandId: string, path = '') => `/api/v1/brands/${brandId}/onboarding${path}`
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

const ANSWERS = [
  { key: 'proof_points', text: 'What can you prove?', value: 'We have coated 3,000 cars since 2019.' },
  { key: 'never_say', text: 'What must we never say?', value: 'Never call us cheap.' },
  { key: 'tone_limits', text: 'Any limits on tone?', value: '   ' },
]

// A brand whose onboarding is at facts and rules, with a finished questionnaire, a profile, and (by default) one
// active fact and one active rule, both confirmed through the API as the owner does.
async function fresh(opts: { step?: string; fact?: boolean } = {}): Promise<string> {
  const brandId = await addBrand(stack, `choices-${(brands += 1)}`)
  await q(`insert into app.onboarding (brand_id, step, intake) values ($1, $2, $3::jsonb)`, [
    brandId,
    opts.step ?? 'facts_rules',
    JSON.stringify({ website: 'https://aztek.example/', socials: {}, competitors: [] }),
  ])
  await q(
    `insert into app.profile_item (brand_id, key, value, status) values
       ($1, 'what_they_sell', '"Ceramic coatings"', 'found'),
       ($1, 'tone_of_voice', '"Warm"', 'assumed')`,
    [brandId],
  )
  const run = await q(
    `insert into app.run (brand_id, agent, definition_version_id, state, started_by_kind)
     values ($1, 'questionnaire', $2, 'succeeded', 'system') returning id`,
    [brandId, definitionId],
  )
  const z = await q(
    `insert into app.questionnaire (brand_id, run_id, finished_at, finished_by) values ($1, $2, now(), $3) returning id`,
    [brandId, run[0].id, ownerId],
  )
  let position = 0
  for (const a of ANSWERS) {
    position += 1
    const question = await q(
      `insert into app.question (brand_id, questionnaire_id, key, position, text, why)
       values ($1, $2, $3, $4, $5, 'It shapes the brief.') returning id`,
      [brandId, z[0].id, a.key, position, a.text],
    )
    const answer = await q(
      `insert into app.answer (brand_id, question_id, value, answered_by, answered_at)
       values ($1, $2, $3, $4, now() - interval '1 hour') returning answered_at`,
      [brandId, question[0].id, a.value, ownerId],
    )
    if (a.value.trim() === '') continue
    const statement = await q(
      `insert into app.research_source (brand_id, run_id, kind, result, extract, stated_by, read_at)
       values ($1, $2, 'owner_statement', 'stated', $3, $4, $5) returning id`,
      [brandId, run[0].id, a.value, ownerId, answer[0].answered_at],
    )
    await q('update app.answer set source_id = $2 where question_id = $1', [question[0].id, statement[0].id])
  }
  if (opts.fact !== false) {
    const fact = await owner.request('POST', api(brandId, '/facts'), {
      body: { statement: 'Open since 2019.', reviewDate: day(90) },
    })
    expect(fact.status, JSON.stringify(fact.json)).toBe(200)
    const rule = await owner.request('POST', api(brandId, '/rules'), {
      body: { kind: 'forbidden_word', text: 'cheap', why: 'We are not the cheapest.' },
    })
    expect(rule.status).toBe(200)
  }
  return brandId
}

const start = (brandId: string) => owner.request('POST', api(brandId, '/brief-choices'), { body: {} })
const read = async (brandId: string) => {
  const reply = await owner.request('GET', api(brandId, '/brief-choices'))
  expect(reply.status).toBe(200)
  return reply.json
}
const decide = (brandId: string, suggestionId: string, body: unknown) =>
  owner.request('POST', api(brandId, `/suggestions/${suggestionId}/decision`), { body })

async function started(brandId: string): Promise<{ runId: string; jobId: string }> {
  const reply = await start(brandId)
  expect(reply.status, JSON.stringify(reply.json)).toBe(200)
  return reply.json as { runId: string; jobId: string }
}

const inputOf = async (jobId: string): Promise<BriefChoicesInput> =>
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

type Choice = BriefChoicesResult['choices'][number]
const choice = (key: Choice['key'], first = 'Owners of new cars', second = 'Fleet managers'): Choice => ({
  key,
  question: `Which ${key}?`,
  why: 'It decides the brief.',
  options: [
    { value: first, tradeOff: 'Reaches many, converts slowly.', recommended: true },
    { value: second, tradeOff: 'Fewer, but they buy in bulk.', recommended: false },
  ],
})
const THREE = [
  choice('lead_audience'),
  choice('positioning_angle', 'Long-lasting shine', 'Price'),
  choice('first_channels', 'Instagram', 'Google'),
]
const result = (choices: Choice[] = THREE): BriefChoicesResult => ({ choices, ask: null })
const post = async (jobId: string, body: unknown) =>
  postResult(jobs, await claim(jobId), { type: TYPE, result: body })

const choicesOf = (brandId: string) =>
  q(
    `select id, run_id, key, proposed, why, source_ids, confidence, options, decision, decided_value, superseded_by
       from app.suggestion where brand_id = $1 and step = 'choice'
      order by created_at, array_position($2::text[], key), id`,
    [brandId, CHOICE_KEYS],
  )

// A brand with a finished brief choices run, its three choices open.
async function withChoices(): Promise<string> {
  const brandId = await fresh()
  const { jobId } = await started(brandId)
  await post(jobId, result())
  return brandId
}

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  registerBriefChoicesHandlers(jobs.results, jobs)
  definitionId = await seedDefinition(stack.db)
  ownerId = await addUser(stack, { email: 'owner@bc.test', password: PASSWORD, platformOwner: true })
  adminBrand = await addBrand(stack, 'choices-admin')
  await addUser(stack, {
    email: 'admin@bc.test',
    password: PASSWORD,
    role: 'brand_admin',
    brandId: adminBrand,
  })
  owner = (await enrolledClient(stack, 'owner@bc.test', PASSWORD)).client
  admin = (await enrolledClient(stack, 'admin@bc.test', PASSWORD)).client
  for (const [agent, dir] of [
    ['brief_choices', DIR],
    ['facts_rules', FR_DIR],
  ] as const)
    await q(
      `insert into app.agent_definition_version (agent, version, model, effort, files_hash, live)
       values ($1, 1, 'claude-sonnet-5-5', 'medium', $2, true)`,
      [agent, agentFilesHash(dir)],
    )
}, 120_000)
afterAll(async () => stack?.close())

describe('brief choices', () => {
  it('starting brief choices builds its input from the profile, the active facts, the rules and the answers', async () => {
    const brandId = await fresh()
    // A retired fact and a turned-off rule are not sent.
    const gone = await owner.request('POST', api(brandId, '/facts'), {
      body: { statement: 'Open since 2018.', reviewDate: day(90) },
    })
    await owner.request('POST', api(brandId, `/facts/${gone.json.factId}/retire`), { body: {} })
    const off = await owner.request('POST', api(brandId, '/rules'), {
      body: { kind: 'tone_limit', text: 'no slang', why: 'Formal.' },
    })
    await owner.request('POST', api(brandId, `/rules/${off.json.ruleId}/turn-off`), { body: {} })

    const { runId, jobId } = await started(brandId)
    const run = await q('select agent, state from app.run where id = $1', [runId])
    expect(run[0]).toEqual({ agent: 'brief_choices', state: 'running' })
    const job = (
      await q('select class, agent, expected_result_type from app.job_input where job_id = $1', [jobId])
    )[0]
    expect(job).toEqual({ class: 'production', agent: 'brief_choices', expected_result_type: TYPE })
    const input = await inputOf(jobId)
    expect(() => briefChoicesInputSchema.parse(input)).not.toThrow()
    expect(input.brandName).toBe((await q('select name from app.brand where id = $1', [brandId]))[0].name)
    const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key)
    expect([...input.profile].sort(byKey)).toEqual([
      { key: 'tone_of_voice', value: 'Warm', status: 'assumed' },
      { key: 'what_they_sell', value: 'Ceramic coatings', status: 'found' },
    ])
    const facts = await q(
      `select id, statement from app.verified_fact where brand_id = $1 and status = 'active'`,
      [brandId],
    )
    expect(input.facts).toEqual([{ id: facts[0].id, statement: 'Open since 2019.' }])
    expect(input.rules).toEqual([{ kind: 'forbidden_word', text: 'cheap' }])
    // The latest finished questionnaire's non-blank answers, in question order.
    expect(input.answers).toEqual([
      { key: 'proof_points', question: 'What can you prove?', answer: ANSWERS[0]!.value },
      { key: 'never_say', question: 'What must we never say?', answer: ANSWERS[1]!.value },
    ])
    const audit = await q(
      `select detail from audit.log where action = 'onboarding.brief_choices_started' and brand_id = $1`,
      [brandId],
    )
    expect(audit.map((r) => r.detail)).toEqual([{ runId }])
  })

  it('brief choices are refused while a fact or rule is undecided, and with no active fact', async () => {
    const refused = async (brandId: string, status: number, code: string) => {
      const reply = await start(brandId)
      expect(reply.status).toBe(status)
      expect(reply.json).toMatchObject({ error: { code } })
      expect(
        (await q(`select 1 from app.run where brand_id = $1 and agent = 'brief_choices'`, [brandId])).length,
      ).toBe(0)
    }
    await refused(await fresh({ step: 'questionnaire' }), 409, 'facts_rules_needed')
    await refused(await fresh({ fact: false }), 409, 'facts_needed')
    const open = await fresh()
    await q(
      `insert into app.suggestion (brand_id, step, key, proposed, why, confidence)
       values ($1, 'rule', 'rule:x', '{"kind":"tone_limit","text":"no slang"}'::jsonb, 'Why.', 'assumed')`,
      [open],
    )
    await refused(open, 409, 'facts_rules_open')
    // A facts and rules job still open.
    const running = await fresh()
    expect((await owner.request('POST', api(running, '/facts-rules'), { body: {} })).status).toBe(200)
    await refused(running, 409, 'facts_rules_running')
    // No live release.
    const down = await fresh()
    await q(`update app.agent_definition_version set live = false where agent = 'brief_choices'`)
    try {
      await refused(down, 503, 'agent_unavailable')
    } finally {
      await q(`update app.agent_definition_version set live = true where agent = 'brief_choices'`)
    }
    // A second start while the first runs.
    const twice = await fresh()
    await started(twice)
    const again = await start(twice)
    expect(again.status).toBe(409)
    expect(again.json).toMatchObject({ error: { code: 'brief_choices_running' } })
  })

  it('the result becomes choice suggestions with their options and the step moves to brief_choices', async () => {
    const brandId = await fresh()
    const { runId, jobId } = await started(brandId)
    await post(jobId, result())
    const rows = await choicesOf(brandId)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      run_id: runId,
      key: 'lead_audience',
      proposed: { question: 'Which lead_audience?', value: 'Owners of new cars' },
      why: 'It decides the brief.',
      source_ids: [],
      confidence: 'assumed',
      decision: null,
      superseded_by: null,
      options: [
        { value: 'Owners of new cars', tradeOff: 'Reaches many, converts slowly.', recommended: true },
        { value: 'Fleet managers', tradeOff: 'Fewer, but they buy in bulk.', recommended: false },
      ],
    })
    expect((await q('select step from app.onboarding where brand_id = $1', [brandId]))[0].step).toBe(
      'brief_choices',
    )
    expect(
      (
        await q(`select user_id from app.notification where brand_id = $1 and kind = 'brief_choices_ready'`, [
          brandId,
        ])
      ).map((r) => r.user_id),
    ).toContain(ownerId)
    // Nothing but suggestions is written.
    expect((await q('select 1 from app.verified_fact where brand_id = $1', [brandId])).length).toBe(1)
    expect((await q('select 1 from app.profile_item where brand_id = $1', [brandId])).length).toBe(2)

    const view = await read(brandId)
    expect(view.job).toEqual({ state: 'done' })
    expect(view.choices).toEqual(
      rows.map((r) => ({
        id: r.id,
        key: r.key,
        question: r.proposed.question,
        why: 'It decides the brief.',
        options: r.options,
        decision: null,
        picked: null,
      })),
    )
    expect((await owner.request('GET', api(brandId))).json.briefChoices).toEqual({
      state: 'done',
      total: 3,
      decided: 0,
    })
  })

  it('the step never moves backward, and a result that asks is refused and stores nothing', async () => {
    const later = await fresh({ step: 'brief' })
    const { jobId } = await started(later)
    await post(jobId, result())
    expect((await q('select step from app.onboarding where brand_id = $1', [later]))[0].step).toBe('brief')

    const brandId = await fresh()
    const second = await started(brandId)
    const claims = await claim(second.jobId)
    const ask = { text: 'Which city first?', why: 'Two answers differ.', options: [], suggested: null }
    await expect(
      postResult(jobs, claims, { type: TYPE, result: { choices: [], ask } }),
    ).rejects.toMatchObject({ status: 422, code: 'result_invalid' })
    expect(await choicesOf(brandId)).toEqual([])
  })

  it("a pick of another option or the owner's own words is recorded; rejecting a choice is refused", async () => {
    const brandId = await withChoices()
    const [a, b, c] = await choicesOf(brandId)
    const accepted = await decide(brandId, a.id, { decision: 'accepted' })
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200)
    expect((await choicesOf(brandId))[0]).toMatchObject({
      decision: 'accepted',
      decided_value: { value: 'Owners of new cars' },
    })
    expect((await decide(brandId, b.id, { decision: 'edited', value: { value: 'Price' } })).status).toBe(200)
    expect((await decide(brandId, c.id, { decision: 'rejected' })).status).toBe(400)
    const refused = await decide(brandId, c.id, { decision: 'rejected', reason: 'no' })
    expect(refused.json).toMatchObject({
      error: { code: 'choice_needs_pick', message: 'Pick one of the options, or write your own.' },
    })
    const own = await decide(brandId, c.id, { decision: 'edited', value: { value: 'Only Instagram, daily' } })
    expect(own.status).toBe(200)
    // Too long, empty or of the wrong shape: refused, and still open.
    const other = await withChoices()
    const [x] = await choicesOf(other)
    for (const value of [{ value: 'a'.repeat(301) }, { value: '  ' }, 'plain', { text: 'x' }]) {
      const reply = await decide(other, x.id, { decision: 'edited', value })
      expect(reply.status, JSON.stringify(value)).toBeGreaterThanOrEqual(400)
      expect(reply.status).toBeLessThan(500)
    }
    expect((await choicesOf(other))[0].decision).toBeNull()

    const view = await read(brandId)
    expect(view.choices.map((ch: { decision: string; picked: string }) => [ch.decision, ch.picked])).toEqual([
      ['accepted', 'Owners of new cars'],
      ['edited', 'Price'],
      ['edited', 'Only Instagram, daily'],
    ])
    expect((await owner.request('GET', api(brandId))).json.briefChoices).toEqual({
      state: 'done',
      total: 3,
      decided: 3,
    })
    // A choice is not a fact or a rule: nothing else was written.
    expect((await q('select 1 from app.verified_fact where brand_id = $1', [brandId])).length).toBe(1)
    expect((await q('select 1 from app.safety_rule where brand_id = $1', [brandId])).length).toBe(1)
    expect((await q('select 1 from app.profile_item where brand_id = $1', [brandId])).length).toBe(2)
  })

  it('a re-run supersedes only undecided choices', async () => {
    const brandId = await withChoices()
    const [a, b, c] = await choicesOf(brandId)
    await decide(brandId, a.id, { decision: 'edited', value: { value: 'Fleet managers' } })
    const { jobId } = await started(brandId)
    await post(
      jobId,
      result([choice('lead_audience'), choice('positioning_angle'), choice('first_channels')]),
    )
    const all = await choicesOf(brandId)
    expect(all).toHaveLength(6)
    const byId = new Map(all.map((r) => [r.id, r]))
    expect(byId.get(a.id)).toMatchObject({ decision: 'edited', superseded_by: null })
    expect(byId.get(b.id)!.superseded_by).not.toBeNull()
    expect(byId.get(c.id)!.superseded_by).not.toBeNull()
    // The list holds the owner's decided choice and the two new ones, in insertion order.
    const view = await read(brandId)
    expect(view.choices.map((ch: { key: string; decision: string | null }) => [ch.key, ch.decision])).toEqual(
      [
        ['lead_audience', 'edited'],
        ['lead_audience', null],
        ['positioning_angle', null],
        ['first_channels', null],
      ],
    )
    expect((await owner.request('GET', api(brandId))).json.briefChoices).toMatchObject({
      total: 4,
      decided: 1,
    })
  })

  it('a brand admin gets 403', async () => {
    for (const [method, path] of [
      ['POST', api(adminBrand, '/brief-choices')],
      ['GET', api(adminBrand, '/brief-choices')],
    ] as const) {
      const reply = await admin.request(method, path, { body: method === 'POST' ? {} : undefined })
      expect(reply.status, `${method} ${path}`).toBe(403)
    }
    expect(
      (await q(`select 1 from app.run where brand_id = $1 and agent = 'brief_choices'`, [adminBrand])).length,
    ).toBe(0)
  })
})
