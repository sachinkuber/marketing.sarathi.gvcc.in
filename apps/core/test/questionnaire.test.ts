import { agentFilesHash } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { questionnaireInputSchema, type QuestionnaireResult } from '@mkt/shared'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerQuestionnaireHandlers } from '../src/agents/register.ts'
import { postResult, startAttempt, type JobsDeps } from '../src/jobs/service.ts'
import { verifyAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

// Task 6 of M10 (spec 4, 12): the questionnaire's core side. The job's input is built from the draft profile;
// the result becomes ordered questions; answers save as typed; finishing writes owner statements and profile items.

const PASSWORD = 'correct horse battery'
const dir = (name: string) => fileURLToPath(new URL(`../../../agents/${name}`, import.meta.url))
const INTAKE = {
  website: 'https://aztek.example/',
  socials: {},
  competitors: [{ name: 'Rival', website: 'https://rival.example/' }, { name: 'Other' }],
}

let stack: Stack
let jobs: JobsDeps
let definitionId: string
let ownerId: string
let owner: TestClient
let admin: TestClient
let brands = 0
let adminBrand: string

const q = async (sql: string, params: unknown[] = []) => (await stack.db.admin.query(sql, params)).rows
const base = (brandId: string) => `/api/v1/brands/${brandId}/onboarding/questionnaire`

interface Fresh {
  brandId: string
  researchRunId: string
}

// A brand at the profile step, with a finished research run behind it.
async function fresh(step = 'profile', research = true): Promise<Fresh> {
  const brandId = await addBrand(stack, `questionnaire-${(brands += 1)}`)
  const run = await q(
    `insert into app.run (brand_id, agent, definition_version_id, state, started_by_kind)
     values ($1, 'research', $2, $3, 'system') returning id`,
    [brandId, definitionId, research ? 'succeeded' : 'running'],
  )
  const researchRunId = run[0].id as string
  await q(
    `insert into app.onboarding (brand_id, intake, step, research_run_id) values ($1, $2::jsonb, $3, $4)`,
    [brandId, JSON.stringify(INTAKE), step, researchRunId],
  )
  return { brandId, researchRunId }
}

const start = (brandId: string) => owner.request('POST', base(brandId), { body: {} })
const finish = (brandId: string) => owner.request('POST', `${base(brandId)}/finish`, { body: {} })
const put = (brandId: string, questionId: string, value: string) =>
  owner.request('PUT', `${base(brandId)}/answers/${questionId}`, { body: { value } })

const QUESTION_KEYS_USED = [
  'business_name',
  'tone_of_voice',
  'goals',
  'priority_audiences',
  'capacity',
  'success_measures',
  'never_say',
  'competitors_not_named',
  'tone_limits',
  'pause_dates',
] as const
const RESULT: QuestionnaireResult = {
  questions: QUESTION_KEYS_USED.map((key, i) => ({
    key,
    text: `Question ${i + 1} about ${key.replace(/_/g, ' ')}?`,
    why: `Because ${key.replace(/_/g, ' ')} shapes the brief.`,
    options: i === 0 ? ['Aztek', 'Aztek Labs'] : [],
    suggestedAnswer: i === 0 ? 'Aztek' : null,
  })),
  ask: null,
}

async function claim(jobId: string): Promise<AttemptClaims> {
  await q(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [jobId])
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

// Starts the questionnaire and posts its result; returns the run, the job and the question ids in order.
async function startAndResult(brandId: string, result: unknown = RESULT) {
  const started = await start(brandId)
  expect(started.status).toBe(200)
  const { runId, jobId } = started.json as { runId: string; jobId: string }
  const posted = await postResult(jobs, await claim(jobId), { type: 'questionnaire.v1', result })
  const ids = (
    await q(
      `select q.id from app.question q join app.questionnaire z on z.id = q.questionnaire_id
        where z.brand_id = $1 and z.run_id = $2 order by q.position`,
      [brandId, runId],
    )
  ).map((r) => r.id as string)
  return { runId, jobId, posted, ids }
}

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  registerQuestionnaireHandlers(jobs.results)
  definitionId = await seedDefinition(stack.db)
  ownerId = await addUser(stack, { email: 'owner@qn.test', password: PASSWORD, platformOwner: true })
  adminBrand = await addBrand(stack, 'questionnaire-admin')
  await addUser(stack, {
    email: 'admin@qn.test',
    password: PASSWORD,
    role: 'brand_admin',
    brandId: adminBrand,
  })
  owner = (await enrolledClient(stack, 'owner@qn.test', PASSWORD)).client
  admin = (await enrolledClient(stack, 'admin@qn.test', PASSWORD)).client
  await q(
    `insert into app.agent_definition_version (agent, version, model, effort, files_hash, live)
     values ('questionnaire', 1, 'claude-sonnet-5-5', 'medium', $1, true)`,
    [agentFilesHash(dir('questionnaire'))],
  )
}, 120_000)
afterAll(async () => stack?.close())

describe('starting the questionnaire', () => {
  it('starting the questionnaire builds its input from the profile, the gaps and the unread sources', async () => {
    const { brandId, researchRunId } = await fresh()
    // The profile: one current item for business_name, and an older one that was superseded.
    const old = await q(
      `insert into app.profile_item (brand_id, key, value, status) values ($1, 'tone_of_voice', '"old tone"', 'found') returning id`,
      [brandId],
    )
    const current = await q(
      `insert into app.profile_item (brand_id, key, value, status) values ($1, 'tone_of_voice', '"warm and plain"', 'assumed') returning id`,
      [brandId],
    )
    await q(`update app.profile_item set superseded_by = $2 where id = $1`, [old[0].id, current[0].id])
    await q(
      `insert into app.profile_item (brand_id, key, value, status) values ($1, 'business_name', '"Aztek"', 'found')`,
      [brandId],
    )
    // Suggestions: one undecided, one rejected, one accepted and one replaced (neither is sent).
    const sug = (key: string, decision: string | null, superseded = false) =>
      q(
        `insert into app.suggestion (brand_id, step, key, proposed, why, confidence, decision, superseded_by)
         values ($1, 'profile', $2, $3::jsonb, 'seen', 'assumed', $4::app.suggestion_decision, null) returning id`,
        [brandId, key, JSON.stringify(`proposed ${key}`), decision],
      ).then(async (r) => {
        if (superseded) {
          await q(`update app.suggestion set superseded_by = $2 where id = $1`, [r[0].id, r[0].id])
        }
      })
    await sug('price_position', null)
    await sug('certifications', 'rejected')
    await sug('places_served', 'accepted')
    await sug('audiences', null, true)
    // Sources: a page read, one blocked, one that errored; and an owner statement that is never "unreadable".
    const src = (kind: string, address: string | null, result: string) =>
      q(
        `insert into app.research_source (brand_id, run_id, kind, address, result, extract) values ($1, $2, $3, $4, $5, 'x')`,
        [brandId, researchRunId, kind, address, result],
      )
    await src('site', 'https://aztek.example/', 'read')
    await src('social', 'https://instagram.com/aztek', 'blocked')
    await src('document', null, 'error')
    // The latest done merge's gaps (an older merge's gaps are not used).
    // Only the merge of the brand's current research run counts: a newer merge of another run is not used.
    const merge = async (runId: string, gaps: unknown, at: string) => {
      await q(
        `insert into app.job_input (job_id, brand_id, run_id, class, input, expected_result_type, outcome, finished_at)
         values (gen_random_uuid(), $1, $2, 'production', '{}', 'research.v1', $3::jsonb, $4::timestamptz)`,
        [brandId, runId, JSON.stringify({ suggestions: 1, gaps }), at],
      )
    }
    const otherRun = (
      await q(
        `insert into app.run (brand_id, agent, definition_version_id, state, started_by_kind)
         values ($1, 'research', $2, 'succeeded', 'system') returning id`,
        [brandId, definitionId],
      )
    )[0].id as string
    await merge(
      researchRunId,
      [{ key: 'price_position', why: 'No prices were found.' }],
      '2026-11-01T00:00:00Z',
    )
    await merge(otherRun, [{ key: 'certifications', why: 'Another run.' }], '2026-11-02T00:00:00Z')

    const started = await start(brandId)
    expect(started.status).toBe(200)
    const { runId, jobId } = started.json as { runId: string; jobId: string }
    const run = await q(`select agent, state from app.run where id = $1`, [runId])
    expect(run[0]).toEqual({ agent: 'questionnaire', state: 'running' })
    const job = (
      await q(`select input, class, agent, expected_result_type from app.job_input where job_id = $1`, [
        jobId,
      ])
    )[0]
    expect(job).toMatchObject({
      class: 'production',
      agent: 'questionnaire',
      expected_result_type: 'questionnaire.v1',
    })
    expect(() => questionnaireInputSchema.parse(job.input)).not.toThrow()
    const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key)
    expect(job.input.brandName).toBe(`questionnaire-${brands}`)
    expect([...job.input.profile].sort(byKey)).toEqual([
      { key: 'business_name', value: 'Aztek', status: 'found' },
      { key: 'tone_of_voice', value: 'warm and plain', status: 'assumed' },
    ])
    expect([...job.input.open].sort(byKey)).toEqual([
      { key: 'certifications', proposed: 'proposed certifications', confidence: 'assumed', rejected: true },
      { key: 'price_position', proposed: 'proposed price_position', confidence: 'assumed', rejected: false },
    ])
    expect(job.input.gaps).toEqual([{ key: 'price_position', why: 'No prices were found.' }])
    expect(job.input.unreadable).toEqual([
      { kind: 'social', address: 'https://instagram.com/aztek' },
      { kind: 'document', address: null },
    ])
    expect(job.input.competitors).toEqual([
      { name: 'Rival', website: 'https://rival.example/' },
      { name: 'Other', website: null },
    ])
    const audit = await q(
      `select detail from audit.log where action = 'onboarding.questionnaire_started' and brand_id = $1`,
      [brandId],
    )
    expect(audit.map((r) => r.detail)).toEqual([{ runId }])
    // The overview shows the job waiting, with nothing to answer yet.
    const overview = await owner.request('GET', `/api/v1/brands/${brandId}/onboarding`)
    expect((overview.json as { questionnaire: unknown }).questionnaire).toEqual({
      state: 'waiting',
      total: 0,
      answered: 0,
      finished: false,
    })
  })

  it('trims the input to the schema caps and gives no gaps when no merge is done', async () => {
    const { brandId, researchRunId } = await fresh()
    await q(`update app.onboarding set intake = $2::jsonb where brand_id = $1`, [
      brandId,
      JSON.stringify({
        ...INTAKE,
        competitors: Array.from({ length: 7 }, (_, i) => ({ name: `Rival ${i}` })),
      }),
    ])
    for (let i = 0; i < 65; i += 1) {
      await q(
        `insert into app.research_source (brand_id, run_id, kind, address, result, extract)
         values ($1, $2, 'search', $3, 'blocked', 'x')`,
        [brandId, researchRunId, `https://page${i}.example/`],
      )
    }
    for (let i = 0; i < 45; i += 1) {
      await q(
        `insert into app.suggestion (brand_id, step, key, proposed, why, confidence)
         values ($1, 'profile', 'competitors', $2::jsonb, 'seen', 'assumed')`,
        [brandId, JSON.stringify(`value ${i}`)],
      )
    }
    const started = await start(brandId)
    const input = (await q(`select input from app.job_input where job_id = $1`, [started.json.jobId]))[0]
      .input
    expect(input.open).toHaveLength(40)
    // The newest 40 are kept: values 5 to 44.
    expect(input.open.map((o: { proposed: string }) => o.proposed).sort()).toEqual(
      Array.from({ length: 40 }, (_, i) => `value ${i + 5}`).sort(),
    )
    expect(input.unreadable).toHaveLength(60)
    expect(input.competitors).toHaveLength(5)
    expect(input.gaps).toEqual([])
    expect(() => questionnaireInputSchema.parse(input)).not.toThrow()
  })

  it('is refused before the profile step, while research runs, with no live release, and twice', async () => {
    const early = await fresh('research')
    const refused = await start(early.brandId)
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ error: { code: 'profile_needed' } })
    const noRow = await addBrand(stack, `questionnaire-${(brands += 1)}`)
    expect((await start(noRow)).json).toMatchObject({ error: { code: 'profile_needed' } })

    const running = await fresh('profile', false)
    const busy = await start(running.brandId)
    expect(busy.status).toBe(409)
    expect(busy.json).toMatchObject({ error: { code: 'research_running' } })

    await q(`update app.agent_definition_version set live = false where agent = 'questionnaire'`)
    const none = await fresh()
    const down = await start(none.brandId)
    await q(`update app.agent_definition_version set live = true where agent = 'questionnaire'`)
    expect(down.status).toBe(503)
    expect(down.json).toMatchObject({ error: { code: 'agent_unavailable' } })
    expect(
      (await q('select 1 from app.run where brand_id = $1 and agent = $2', [none.brandId, 'questionnaire']))
        .length,
    ).toBe(0)
  })

  it('a second start while one is open is refused', async () => {
    const { brandId } = await fresh()
    expect((await start(brandId)).status).toBe(200)
    // The job has not produced questions yet.
    const again = await start(brandId)
    expect(again.status).toBe(409)
    expect(again.json).toMatchObject({
      error: {
        code: 'questionnaire_open',
        message: 'The questionnaire is still being written. Wait for it, or answer its question.',
      },
    })
    expect(
      (await q('select 1 from app.run where brand_id = $1 and agent = $2', [brandId, 'questionnaire']))
        .length,
    ).toBe(1)
    // And once the questions exist and are not finished.
    const { jobId } = (
      await q(`select job_id as "jobId" from app.job_input where brand_id = $1 and agent = 'questionnaire'`, [
        brandId,
      ])
    )[0]
    await postResult(jobs, await claim(jobId), { type: 'questionnaire.v1', result: RESULT })
    const open = await start(brandId)
    expect(open.json).toMatchObject({ error: { code: 'questionnaire_open' } })
  })

  it('a brand admin gets 403', async () => {
    const brandId = adminBrand
    await q(`insert into app.onboarding (brand_id, step) values ($1, 'profile') on conflict do nothing`, [
      brandId,
    ])
    for (const [method, path, body] of [
      ['POST', base(brandId), {}],
      ['GET', base(brandId), undefined],
      ['PUT', `${base(brandId)}/answers/${ownerId}`, { value: 'x' }],
      ['POST', `${base(brandId)}/finish`, {}],
    ] as const) {
      const reply = await admin.request(method, path, { body })
      expect(reply.status, `${method} ${path}`).toBe(403)
    }
    expect(
      (await q('select 1 from app.run where brand_id = $1 and agent = $2', [brandId, 'questionnaire']))
        .length,
    ).toBe(0)
  })
})

describe('the result', () => {
  it('the result becomes ordered questions and the step moves to questionnaire', async () => {
    const { brandId } = await fresh()
    const { runId, posted, ids } = await startAndResult(brandId)
    expect(posted).toMatchObject({ status: 'applied', outcome: { questions: 10 } })
    expect(ids).toHaveLength(10)
    const rows = await q(
      `select key, position, text, why, suggested_answer, options from app.question where brand_id = $1 order by position`,
      [brandId],
    )
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(rows.map((r) => r.key)).toEqual([...QUESTION_KEYS_USED])
    expect(rows[0]).toMatchObject({ suggested_answer: 'Aztek', options: ['Aztek', 'Aztek Labs'] })
    expect(rows[1]).toMatchObject({ suggested_answer: null, options: [] })
    expect((await q('select run_id from app.questionnaire where brand_id = $1', [brandId]))[0].run_id).toBe(
      runId,
    )
    expect((await q('select step from app.onboarding where brand_id = $1', [brandId]))[0].step).toBe(
      'questionnaire',
    )
    expect(
      (
        await q(
          `select user_id, kind from app.notification where brand_id = $1 and kind = 'questionnaire_ready'`,
          [brandId],
        )
      ).map((r) => r.user_id),
    ).toContain(ownerId)

    const read = await owner.request('GET', base(brandId))
    expect(read.status).toBe(200)
    expect(read.json.job).toEqual({ state: 'done' })
    expect(read.json.questionnaire.finishedAt).toBeNull()
    expect(read.json.questionnaire.questions[0]).toEqual({
      id: ids[0],
      key: 'business_name',
      position: 1,
      text: 'Question 1 about business name?',
      why: 'Because business name shapes the brief.',
      options: ['Aztek', 'Aztek Labs'],
      suggestedAnswer: 'Aztek',
      answer: null,
    })
    const overview = await owner.request('GET', `/api/v1/brands/${brandId}/onboarding`)
    expect(overview.json.questionnaire).toEqual({ state: 'done', total: 10, answered: 0, finished: false })
  })

  it('a result that asks, or is short of questions, stores nothing', async () => {
    const { brandId } = await fresh()
    const started = await start(brandId)
    const claims = await claim(started.json.jobId)
    await expect(
      postResult(jobs, claims, {
        type: 'questionnaire.v1',
        result: { questions: RESULT.questions.slice(0, 3), ask: null },
      }),
    ).rejects.toMatchObject({ status: 422 })
    expect((await q('select 1 from app.questionnaire where brand_id = $1', [brandId])).length).toBe(0)
  })

  it('shows the job waiting for an answer, with its open question', async () => {
    const { brandId } = await fresh()
    const started = await start(brandId)
    await claim(started.json.jobId)
    const asked = await q(
      `insert into app.agent_question (brand_id, run_id, job_id, question, why) values ($1, $2, $3, 'Which city?', 'Two are named.') returning id`,
      [brandId, started.json.runId, started.json.jobId],
    )
    const read = await owner.request('GET', base(brandId))
    expect(read.json).toEqual({
      questionnaire: null,
      job: { state: 'waiting_for_answer', questionId: asked[0].id },
    })
    const overview = await owner.request('GET', `/api/v1/brands/${brandId}/onboarding`)
    expect(overview.json.questionnaire.state).toBe('waiting_for_answer')
  })
})

describe('answers and finishing', () => {
  it('answers save as typed and a half-answered questionnaire can be finished', async () => {
    const { brandId } = await fresh()
    const { ids } = await startAndResult(brandId)
    const typed = '  Aztek, not "Aztek Labs"\n  (two spaces kept)  '
    expect((await put(brandId, ids[0]!, typed)).json).toEqual({ answered: true })
    expect(
      (await q('select value from app.answer where brand_id = $1', [brandId])).map((r) => r.value),
    ).toEqual([typed])
    // Saved again, replaced in place.
    expect((await put(brandId, ids[0]!, 'Aztek')).status).toBe(200)
    expect((await put(brandId, ids[2]!, 'Grow the shop')).status).toBe(200)
    expect(
      (await q('select value from app.answer where brand_id = $1 order by value', [brandId])).map(
        (r) => r.value,
      ),
    ).toEqual(['Aztek', 'Grow the shop'])
    // Empty deletes.
    expect((await put(brandId, ids[2]!, '')).json).toEqual({ answered: false })
    expect((await q('select 1 from app.answer where brand_id = $1', [brandId])).length).toBe(1)
    const read = await owner.request('GET', base(brandId))
    expect(read.json.questionnaire.questions.map((x: { answer: string | null }) => x.answer)).toEqual([
      'Aztek',
      ...Array(9).fill(null),
    ])
    // At most 2000 characters.
    expect((await put(brandId, ids[1]!, 'x'.repeat(2000))).status).toBe(200)
    const long = await put(brandId, ids[1]!, 'x'.repeat(2001))
    expect(long.status).toBe(400)
    // No audit entry per save.
    expect(
      (
        await q(`select 1 from audit.log where brand_id = $1 and action like 'onboarding.questionnaire%'`, [
          brandId,
        ])
      ).length,
    ).toBe(1)
    const overview = await owner.request('GET', `/api/v1/brands/${brandId}/onboarding`)
    expect(overview.json.questionnaire).toMatchObject({ total: 10, answered: 2, finished: false })
    // Half answered: finish anyway.
    const done = await finish(brandId)
    expect(done.status).toBe(200)
    expect(done.json).toEqual({ answered: 2, blank: 8 })
  })

  it('finishing writes one owner statement per answer and profile items for profile keys', async () => {
    const { brandId, researchRunId } = await fresh()
    // The research item for business_name, to be superseded.
    const found = await q(
      `insert into app.profile_item (brand_id, key, value, status) values ($1, 'business_name', '"Aztec"', 'assumed') returning id`,
      [brandId],
    )
    const { runId, ids } = await startAndResult(brandId)
    await put(brandId, ids[0]!, 'Aztek')
    await put(brandId, ids[1]!, 'Plain and warm')
    await put(brandId, ids[2]!, 'Open a second shop')
    await put(brandId, ids[6]!, 'Never promise cures')
    await put(brandId, ids[7]!, '   ')
    const done = await finish(brandId)
    expect(done.json).toEqual({ answered: 4, blank: 6 })

    const statements = await q(
      `select id, run_id, kind, result, extract, stated_by, read_at from app.research_source
        where brand_id = $1 and kind = 'owner_statement' order by extract`,
      [brandId],
    )
    expect(statements.map((s) => s.extract)).toEqual([
      'Aztek',
      'Never promise cures',
      'Open a second shop',
      'Plain and warm',
    ])
    for (const s of statements) {
      expect(s).toMatchObject({ result: 'stated', stated_by: ownerId, run_id: runId })
      expect(s.run_id).not.toBe(researchRunId)
    }
    const answers = await q(
      `select value, source_id, answered_at from app.answer where brand_id = $1 order by value`,
      [brandId],
    )
    expect(answers).toHaveLength(4)
    for (const a of answers) {
      const statement = statements.find((s) => s.id === a.source_id)
      expect(statement?.extract).toBe(a.value)
      // The statement is dated when the owner answered.
      expect(new Date(statement!.read_at).getTime()).toBe(new Date(a.answered_at).getTime())
    }
    // Profile items: business_name and tone_of_voice are profile keys; goals and never_say are not.
    const items = await q(
      `select id, key, value, status, source_ids, superseded_by from app.profile_item where brand_id = $1 order by created_at`,
      [brandId],
    )
    const current = items.filter((i) => i.superseded_by === null)
    expect(current.map((i) => [i.key, i.value, i.status]).sort()).toEqual([
      ['business_name', 'Aztek', 'found'],
      ['tone_of_voice', 'Plain and warm', 'found'],
    ])
    const name = current.find((i) => i.key === 'business_name')
    expect(name.source_ids).toEqual([statements.find((s) => s.extract === 'Aztek')!.id])
    expect(items.find((i) => i.id === found[0].id)!.superseded_by).toBe(name.id)

    const z = (
      await q('select finished_at, finished_by from app.questionnaire where brand_id = $1', [brandId])
    )[0]
    expect(z.finished_at).not.toBeNull()
    expect(z.finished_by).toBe(ownerId)
    expect((await q('select step from app.onboarding where brand_id = $1', [brandId]))[0].step).toBe(
      'facts_rules',
    )
    const audit = await q(
      `select detail from audit.log where action = 'onboarding.questionnaire_finished' and brand_id = $1`,
      [brandId],
    )
    expect(audit).toHaveLength(1)
    expect(audit[0].detail).toEqual({ questionnaireId: expect.any(String), answered: 4, blank: 6 })
    const overview = await owner.request('GET', `/api/v1/brands/${brandId}/onboarding`)
    expect(overview.json.step).toBe('facts_rules')
    expect(overview.json.questionnaire).toEqual({ state: 'done', total: 10, answered: 4, finished: true })
  })

  it('a second finish is refused, and a double finish writes one set of statements', async () => {
    const { brandId } = await fresh()
    const { ids } = await startAndResult(brandId)
    await put(brandId, ids[0]!, 'Aztek')
    await put(brandId, ids[2]!, 'More shops')
    const both = await Promise.all([finish(brandId), finish(brandId)])
    expect(both.map((r) => r.status).sort()).toEqual([200, 409])
    expect(both.find((r) => r.status === 409)!.json).toMatchObject({
      error: { code: 'questionnaire_finished' },
    })
    const again = await finish(brandId)
    expect(again.status).toBe(409)
    expect(again.json).toMatchObject({ error: { code: 'questionnaire_finished' } })
    expect(
      (
        await q(`select 1 from app.research_source where brand_id = $1 and kind = 'owner_statement'`, [
          brandId,
        ])
      ).length,
    ).toBe(2)
    expect((await q(`select 1 from app.profile_item where brand_id = $1`, [brandId])).length).toBe(1)
    expect(
      (
        await q(
          `select 1 from audit.log where brand_id = $1 and action = 'onboarding.questionnaire_finished'`,
          [brandId],
        )
      ).length,
    ).toBe(1)
  })

  it('an answer after finish is refused', async () => {
    const { brandId } = await fresh()
    const { ids } = await startAndResult(brandId)
    await put(brandId, ids[0]!, 'Aztek')
    expect((await finish(brandId)).status).toBe(200)
    for (const value of ['Changed', '']) {
      const late = await put(brandId, ids[0]!, value)
      expect(late.status).toBe(409)
      expect(late.json).toMatchObject({ error: { code: 'questionnaire_finished' } })
    }
    expect(
      (await q('select value from app.answer where brand_id = $1', [brandId])).map((r) => r.value),
    ).toEqual(['Aztek'])
  })

  it('finishing with no questionnaire is refused, and a question of another brand is not found', async () => {
    const { brandId } = await fresh()
    const none = await finish(brandId)
    expect(none.status).toBe(409)
    expect(none.json).toMatchObject({ error: { code: 'questionnaire_needed' } })
    const mine = await fresh()
    const { ids } = await startAndResult(mine.brandId)
    expect((await put(brandId, ids[0]!, 'x')).status).toBe(404)
    expect((await q('select 1 from app.answer where brand_id = $1', [mine.brandId])).length).toBe(0)
  })
})

describe('a restart after finish', () => {
  it('a restart after finish does not move the step back, and shows no questionnaire until the new questions arrive', async () => {
    const { brandId } = await fresh()
    const first = await startAndResult(brandId)
    await put(brandId, first.ids[0]!, 'Aztek')
    expect((await finish(brandId)).status).toBe(200)

    const started = await start(brandId)
    expect(started.status).toBe(200)
    // The new job has no questions yet: the view is empty, not the finished questionnaire.
    const waiting = await owner.request('GET', base(brandId))
    expect(waiting.json).toEqual({ questionnaire: null, job: { state: 'waiting' } })
    const overview = await owner.request('GET', `/api/v1/brands/${brandId}/onboarding`)
    expect(overview.json.questionnaire).toEqual({ state: 'waiting', total: 0, answered: 0, finished: false })

    const posted = await postResult(jobs, await claim(started.json.jobId), {
      type: 'questionnaire.v1',
      result: RESULT,
    })
    expect(posted).toMatchObject({ status: 'applied', outcome: { questions: 10 } })
    expect((await q('select step from app.onboarding where brand_id = $1', [brandId]))[0].step).toBe(
      'facts_rules',
    )
    const read = await owner.request('GET', base(brandId))
    expect(read.json.questionnaire.finishedAt).toBeNull()
    expect(read.json.questionnaire.questions.every((x: { answer: unknown }) => x.answer === null)).toBe(true)
    expect(read.json.questionnaire.id).not.toBe(
      (await q('select id from app.questionnaire where run_id = $1', [first.runId]))[0].id,
    )
  })
})
