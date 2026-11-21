import { seedDefinition } from '@mkt/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'

let stack: Stack
let brandId: string
let owner: TestClient
let admin: TestClient
let definitionId: string

const base = () => `/api/v1/brands/${brandId}/onboarding`
const q = (sql: string, params: unknown[] = []) => stack.db.admin.query(sql, params)

async function suggestion(
  step: string,
  agent: string | null,
  decision: 'accepted' | 'edited' | 'rejected' | null,
): Promise<string> {
  let runId: string | null = null
  if (agent) {
    runId = (
      await q(
        `insert into app.run (brand_id, agent, definition_version_id, state, started_by_kind)
         values ($1, $2, $3, 'succeeded', 'system') returning id`,
        [brandId, agent, definitionId],
      )
    ).rows[0].id as string
  }
  const made = await q(
    `insert into app.suggestion (brand_id, run_id, step, key, proposed, why, confidence, decision, decided_value, decided_reason)
     values ($1, $2, $3, $4, '"old"'::jsonb, 'why', 'found', $5, $6::jsonb, $7) returning id`,
    [
      brandId,
      runId,
      step,
      `key_${Math.random().toString(36).slice(2, 8)}`,
      decision,
      decision === 'edited' ? '"new"' : null,
      decision ? 'my reason' : null,
    ],
  )
  return made.rows[0].id as string
}

const cases = async () =>
  (
    await q(
      `select id, agent, status, body, created_by from app.evaluation_case where subject_brand_id = $1`,
      [brandId],
    )
  ).rows

beforeAll(async () => {
  stack = await createStack({ realAudit: true })
  brandId = await addBrand(stack, 'cases-a')
  definitionId = await seedDefinition(stack.db)
  await addUser(stack, { email: 'owner@cases.test', password: PASSWORD, platformOwner: true })
  await addUser(stack, { email: 'admin@cases.test', password: PASSWORD, role: 'brand_admin', brandId })
  owner = (await enrolledClient(stack, 'owner@cases.test', PASSWORD)).client
  admin = (await enrolledClient(stack, 'admin@cases.test', PASSWORD)).client
})
afterAll(async () => stack?.close())

describe('add as a case', () => {
  it('an edited or rejected suggestion can be added as a case, once', async () => {
    const edited = await suggestion('profile', 'research_merge', 'edited')
    const added = await owner.request('POST', `${base()}/suggestions/${edited}/case`, {
      body: { note: 'the tone is wrong' },
    })
    expect(added.status).toBe(200)
    const caseId = added.json.caseId as string
    const row = (await cases()).find((c) => c.id === caseId)!
    expect(row).toMatchObject({ agent: 'research_merge', status: 'candidate' })
    expect(row.body).toMatchObject({
      kind: 'correction',
      suggestionId: edited,
      step: 'profile',
      proposed: 'old',
      decision: 'edited',
      decidedValue: 'new',
      reason: 'my reason',
      note: 'the tone is wrong',
    })
    const audit = await q(
      `select detail from audit.log where action = 'evaluation.case_added' and subject = $1`,
      [caseId],
    )
    expect(audit.rows[0].detail).toEqual({ caseId, agent: 'research_merge' })

    const again = await owner.request('POST', `${base()}/suggestions/${edited}/case`, { body: {} })
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('already_added')

    const rejected = await suggestion('fact', 'facts_rules', 'rejected')
    const second = await owner.request('POST', `${base()}/suggestions/${rejected}/case`, { body: {} })
    expect(second.status).toBe(200)
    expect((await cases()).find((c) => c.id === second.json.caseId)).toMatchObject({ agent: 'facts_rules' })

    // A suggestion with no run falls back to the agent of its step.
    const orphan = await suggestion('choice', null, 'edited')
    const third = await owner.request('POST', `${base()}/suggestions/${orphan}/case`, { body: {} })
    expect(third.status).toBe(200)
    expect((await cases()).find((c) => c.id === third.json.caseId)).toMatchObject({ agent: 'brief_choices' })
  })

  it('an accepted suggestion cannot', async () => {
    const accepted = await suggestion('profile', 'research_merge', 'accepted')
    const before = (await cases()).length
    const refused = await owner.request('POST', `${base()}/suggestions/${accepted}/case`, { body: {} })
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('not_a_correction')
    const open = await suggestion('profile', 'research_merge', null)
    expect((await owner.request('POST', `${base()}/suggestions/${open}/case`, { body: {} })).status).toBe(409)
    expect((await cases()).length).toBe(before)
  })

  it('refuses a note over 1000 characters and a suggestion that does not exist', async () => {
    const edited = await suggestion('profile', 'research_merge', 'edited')
    const long = await owner.request('POST', `${base()}/suggestions/${edited}/case`, {
      body: { note: 'x'.repeat(1001) },
    })
    expect(long.status).toBe(400)
    const none = await owner.request(
      'POST',
      `${base()}/suggestions/00000000-0000-4000-8000-000000000000/case`,
      { body: {} },
    )
    expect(none.status).toBe(404)
  })

  it('an example is stored for the strategist', async () => {
    const made = await owner.request('POST', `${base()}/examples`, {
      body: { example: 'good', text: 'Lead with the buyer’s problem.', note: 'like this' },
    })
    expect(made.status).toBe(200)
    const row = (await cases()).find((c) => c.id === made.json.caseId)!
    expect(row).toMatchObject({ agent: 'strategist', status: 'candidate' })
    expect(row.body).toEqual({
      kind: 'example',
      example: 'good',
      text: 'Lead with the buyer’s problem.',
      note: 'like this',
    })
    const audit = await q(
      `select detail from audit.log where action = 'evaluation.case_added' and subject = $1`,
      [made.json.caseId],
    )
    expect(audit.rows[0].detail).toEqual({ caseId: made.json.caseId, agent: 'strategist' })
    for (const body of [
      { example: 'ok', text: 'x' },
      { example: 'bad', text: '' },
      { example: 'bad', text: 'x'.repeat(4001) },
      { example: 'bad', text: 'x', extra: 1 },
    ])
      expect((await owner.request('POST', `${base()}/examples`, { body })).status, JSON.stringify(body)).toBe(
        400,
      )
  })

  it('a brand admin gets 403', async () => {
    const edited = await suggestion('profile', 'research_merge', 'edited')
    const before = (await cases()).length
    expect((await admin.request('POST', `${base()}/suggestions/${edited}/case`, { body: {} })).status).toBe(
      403,
    )
    expect(
      (await admin.request('POST', `${base()}/examples`, { body: { example: 'good', text: 'x' } })).status,
    ).toBe(403)
    expect((await cases()).length).toBe(before)
  })
})
