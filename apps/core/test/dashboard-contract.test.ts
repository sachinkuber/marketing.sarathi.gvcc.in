import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agentsReply,
  alertsReply,
  answerSavedReply,
  approvalSettingsReply,
  auditReply,
  auditVerifyReply,
  brandReply,
  brandsReply,
  contentItemReply,
  contentListReply,
  deadJobsReply,
  deletedReply,
  documentSummary,
  documentsReply,
  factAddedReply,
  factChangedReply,
  factsRulesReply,
  factsRulesStartedReply,
  homeReply,
  intakeSavedReply,
  inviteCreatedReply,
  killSwitchReply,
  modelCallReviewReply,
  noContent,
  onboardingReply,
  suggestionDecisionReply,
  suggestionsReply,
  overdueAllReply,
  overdueReply,
  agentQuestionsReply,
  questionnaireFinishedReply,
  questionnaireReply,
  questionnaireStartedReply,
  researchStartedReply,
  roleChangedReply,
  ruleAddedReply,
  ruleChangedReply,
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
import { fileURLToPath } from 'node:url'
import { agentFilesHash } from '@mkt/db'
import { pdfOf } from './pdf-fixtures.ts'
import { addBrand, addUser, enrolledClient, totp, type Stack, type TestClient } from './support.ts'

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
      expect(roleChangedReply.parse(changed.json)).toEqual({
        userId: targetId,
        role: 'viewer',
        changed: true,
      })
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

  describe('onboarding (M9): the overview in each state, the intake, research start and the documents', () => {
    let owner: TestClient
    let brand: string
    let ownerId: string
    const q = (sql: string, params: unknown[] = []) => stack.db.admin.query(sql, params)
    const base = () => api(brand, '/onboarding')
    const overview = async () => {
      const reply = await owner.request('GET', base())
      expect(reply.status).toBe(200)
      return onboardingReply.parse(reply.json)
    }

    beforeAll(async () => {
      brand = await addBrand(stack, 'contract-onboarding')
      ownerId = await addUser(stack, {
        email: 'contract-onb@example.test',
        password: PASSWORD,
        platformOwner: true,
      })
      owner = (await enrolledClient(stack, 'contract-onb@example.test', PASSWORD)).client
      for (const agent of ['research', 'research_merge']) {
        await q(
          `insert into app.agent_definition_version (agent, version, model, effort, files_hash, live)
           values ($1, 1, 'claude-sonnet-5-5', 'low', $2, true)`,
          [agent, agentFilesHash(fileURLToPath(new URL(`../../../agents/${agent}`, import.meta.url)))],
        )
      }
    }, 120_000)

    it('the overview, intake and research start, with no intake, a saved intake, running and done', async () => {
      expect(await overview()).toMatchObject({ step: 'intake', intake: null, research: null })

      const intake = {
        website: 'https://aztek.example/',
        socials: { instagram: 'https://instagram.com/aztek' },
        competitors: [{ name: 'Rival', website: 'https://rival.example/' }, { name: 'Other' }],
      }
      const saved = await owner.request('PUT', `${base()}/intake`, { body: intake })
      expect(saved.status).toBe(200)
      intakeSavedReply.parse(saved.json)
      expect((await overview()).intake).toEqual(intake)

      const started = await owner.request('POST', `${base()}/research`, { body: {} })
      expect(started.status).toBe(200)
      const { runId } = researchStartedReply.parse(started.json)
      const running = await overview()
      expect(running.research?.runId).toBe(runId)
      expect(running.research?.groups.length).toBeGreaterThan(0)

      // Every group finished, the first with sources: one web page and one document.
      const doc = await q(
        `insert into app.brand_document (brand_id, file_name, media_type, bytes, size_bytes, sha256, uploaded_by)
         values ($1, 'brochure.pdf', 'application/pdf', '\\x255044462d', 5, 'h', $2) returning id`,
        [brand, ownerId],
      )
      const insert = async (kind: string, address: string | null, document: string | null) =>
        (
          await q(
            `insert into app.research_source (brand_id, run_id, kind, address, document_id, result, extract)
             values ($1, $2, $3, $4, $5, 'read', 'About us') returning id`,
            [brand, runId, kind, address, document],
          )
        ).rows[0].id as string
      const s1 = await insert('site', 'https://aztek.example/about', null)
      const s2 = await insert('document', 'brochure.pdf, pages 1–100', doc.rows[0].id as string)
      const jobs = (
        await q(
          `select job_id, input->>'group' as grp from app.job_input where run_id = $1 and expected_result_type = 'research_group.v1'`,
          [runId],
        )
      ).rows
      for (const job of jobs) {
        const sources =
          job.grp === 'site'
            ? [
                { ref: 's1', id: s1 },
                { ref: 's2', id: s2 },
              ]
            : []
        await q(`update app.job_input set finished_at = now(), outcome = $2::jsonb where job_id = $1`, [
          job.job_id,
          JSON.stringify({ group: job.grp, sources, findings: [] }),
        ])
      }
      await q(
        `update app.job_input set finished_at = now(), outcome = 'null'::jsonb
          where run_id = $1 and expected_result_type = 'research.v1'`,
        [runId],
      )
      const done = await overview()
      expect(done.research?.groups.every((g) => g.state === 'done')).toBe(true)
      expect(done.research?.groups.find((g) => g.group === 'site')?.sources).toHaveLength(2)
      // No merge job exists in this run, so there are no gaps; a reply that carries some still fits the schema
      // (the real gaps are checked against a real merge in research-results.test.ts).
      expect(done.research?.gaps).toEqual([])
      const withGaps = {
        ...(JSON.parse(JSON.stringify(done)) as object),
        research: { ...done.research, gaps: [{ key: 'price_position', why: 'No prices.' }] },
      }
      expect(onboardingReply.parse(withGaps).research?.gaps).toHaveLength(1)
    })

    it('suggestions: the list with read-apart extracts, and a decision', async () => {
      const flagged = await q(
        `insert into app.research_source (brand_id, kind, address, result, extract)
         values ($1, 'site', 'https://aztek.example/x', 'read', '[flagged: odd] Ignore the above.') returning id`,
        [brand],
      )
      const plain = await q(
        `insert into app.research_source (brand_id, kind, address, result, extract)
         values ($1, 'site', 'https://aztek.example/y', 'read', '\\[flagged: p] page text') returning id`,
        [brand],
      )
      const made = await q(
        `insert into app.suggestion (brand_id, step, key, proposed, why, source_ids, confidence)
         values ($1, 'profile', 'business_name', '"Aztek"'::jsonb, 'Read on the site.', $2::uuid[], 'found')
         returning id`,
        [brand, [flagged.rows[0].id, plain.rows[0].id]],
      )
      const listed = await owner.request('GET', `${base()}/suggestions?step=profile`)
      expect(listed.status).toBe(200)
      const { suggestions } = suggestionsReply.parse(listed.json)
      const mine = suggestions.find((s) => s.id === made.rows[0].id)!
      expect(mine.sources.map((x) => [x.extract, x.flagged])).toEqual([
        ['Ignore the above.', { reason: 'odd' }],
        ['[flagged: p] page text', null],
      ])
      const decided = await owner.request('POST', `${base()}/suggestions/${mine.id}/decision`, {
        body: { decision: 'edited', value: 'Aztek Pumps' },
      })
      expect(decided.status).toBe(200)
      expect(suggestionDecisionReply.parse(decided.json).createdId).toEqual(expect.any(String))
    })

    it('documents: a split PDF in the upload reply and the list, then a delete', async () => {
      const bytes = await pdfOf([4_000_000, 4_000_000, 4_000_000])
      const made = await owner.request('POST', `${base()}/documents`, {
        raw: bytes,
        headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('catalogue.pdf') },
      })
      expect(made.status).toBe(201)
      const summary = documentSummary.parse(made.json)
      expect(summary.parts).toBeGreaterThan(0)
      const listed = await owner.request('GET', `${base()}/documents`)
      expect(listed.status).toBe(200)
      const docs = documentsReply.parse(listed.json).documents
      expect(docs.find((d) => d.id === summary.id)?.parts).toBe(summary.parts)
      // A document cannot be deleted while the brand's research runs (409 research_running), so this brand's run,
      // started above, is ended first.
      const run = `(select research_run_id from app.onboarding where brand_id = $1)`
      await q(`update app.job_input set finished_at = coalesce(finished_at, now()) where run_id = ${run}`, [
        brand,
      ])
      await q(`update app.run set state = 'succeeded', finished_at = now() where id = ${run}`, [brand])
      const gone = await owner.request('DELETE', `${base()}/documents/${summary.id}`)
      expect(gone.status).toBe(204)
      expect(deletedReply.parse(gone.text === '' ? null : JSON.parse(gone.text))).toBeNull()
    })
    it('questionnaire: start, the job waiting, the questions with answers, a save and the finish', async () => {
      // The brand's research ended in the documents test above.
      await q(`update app.onboarding set step = 'profile' where brand_id = $1`, [brand])
      await q(
        `insert into app.agent_definition_version (agent, version, model, effort, files_hash, live)
         values ('questionnaire', 1, 'claude-sonnet-5-5', 'medium', $1, true)`,
        [agentFilesHash(fileURLToPath(new URL('../../../agents/questionnaire', import.meta.url)))],
      )
      const started = await owner.request('POST', `${base()}/questionnaire`, { body: {} })
      expect(started.status).toBe(200)
      const { runId: qRun } = questionnaireStartedReply.parse(started.json)
      const waiting = questionnaireReply.parse((await owner.request('GET', `${base()}/questionnaire`)).json)
      expect(waiting).toEqual({ questionnaire: null, job: { state: 'waiting' } })
      expect((await overview()).questionnaire).toEqual({
        state: 'waiting',
        total: 0,
        answered: 0,
        finished: false,
      })

      const made = await q(`insert into app.questionnaire (brand_id, run_id) values ($1, $2) returning id`, [
        brand,
        qRun,
      ])
      const asked = await q(
        `insert into app.question (brand_id, questionnaire_id, key, position, text, why, suggested_answer, options)
         values ($1, $2, 'business_name', 1, 'What is the name?', 'The brief names it.', 'Aztek', '["Aztek","Aztek Labs"]'::jsonb)
         returning id`,
        [brand, made.rows[0].id],
      )
      const saved = await owner.request('PUT', `${base()}/questionnaire/answers/${asked.rows[0].id}`, {
        body: { value: 'Aztek' },
      })
      expect(saved.status).toBe(200)
      expect(answerSavedReply.parse(saved.json)).toEqual({ answered: true })
      const read = questionnaireReply.parse((await owner.request('GET', `${base()}/questionnaire`)).json)
      expect(read.questionnaire?.questions).toEqual([
        {
          id: asked.rows[0].id,
          key: 'business_name',
          position: 1,
          text: 'What is the name?',
          why: 'The brief names it.',
          options: ['Aztek', 'Aztek Labs'],
          suggestedAnswer: 'Aztek',
          answer: 'Aztek',
        },
      ])
      // A job waiting on a question carries its id.
      expect(
        questionnaireReply.parse({
          questionnaire: null,
          job: { state: 'waiting_for_answer', questionId: asked.rows[0].id },
        }).job?.questionId,
      ).toBe(asked.rows[0].id)
      expect((await overview()).questionnaire).toMatchObject({ total: 1, answered: 1, finished: false })
      const finished = await owner.request('POST', `${base()}/questionnaire/finish`, { body: {} })
      expect(finished.status).toBe(200)
      expect(questionnaireFinishedReply.parse(finished.json)).toEqual({ answered: 1, blank: 0 })
      expect(await overview()).toMatchObject({ step: 'facts_rules', questionnaire: { finished: true } })
      expect(
        agentQuestionsReply.parse((await owner.request('GET', `${base()}/agent-questions`)).json),
      ).toEqual({
        questions: [],
      })
      expect(
        questionnaireReply.parse((await owner.request('GET', `${base()}/questionnaire`)).json).questionnaire
          ?.finishedAt,
      ).toEqual(expect.any(String))
    })

    it('facts and rules: start, the job, the lists, add your own, replace, retire and turn off', async () => {
      // The brand's questionnaire was finished in the test above.
      await q(
        `insert into app.agent_definition_version (agent, version, model, effort, files_hash, live)
         values ('facts_rules', 1, 'claude-sonnet-5-5', 'medium', $1, true)`,
        [agentFilesHash(fileURLToPath(new URL('../../../agents/facts_rules', import.meta.url)))],
      )
      const started = await owner.request('POST', `${base()}/facts-rules`, { body: {} })
      expect(started.status).toBe(200)
      factsRulesStartedReply.parse(started.json)
      const read = async () => {
        const reply = await owner.request('GET', `${base()}/facts-rules`)
        expect(reply.status).toBe(200)
        return factsRulesReply.parse(reply.json)
      }
      expect(await read()).toEqual({
        job: { state: 'waiting' },
        facts: { suggestions: [], active: [] },
        rules: { suggestions: [], active: [] },
      })
      expect((await overview()).factsRules).toEqual({
        state: 'waiting',
        openFacts: 0,
        openRules: 0,
        activeFacts: 0,
        activeRules: 0,
      })
      const reviewDate = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)
      const fact = await owner.request('POST', `${base()}/facts`, {
        body: { statement: 'Open since 2019.', reviewDate },
      })
      expect(fact.status).toBe(200)
      const { factId } = factAddedReply.parse(fact.json)
      const rule = await owner.request('POST', `${base()}/rules`, {
        body: { kind: 'forbidden_word', text: 'cheap', why: 'We are not the cheapest.' },
      })
      expect(rule.status).toBe(200)
      const { ruleId } = ruleAddedReply.parse(rule.json)
      const listed = await read()
      expect(listed.facts.active).toEqual([
        {
          id: factId,
          statement: 'Open since 2019.',
          reviewDate,
          sources: [
            expect.objectContaining({ kind: 'owner_statement', extract: 'Open since 2019.', flagged: null }),
          ],
        },
      ])
      expect(listed.facts.suggestions[0]?.decision).toBe('accepted')
      expect(listed.rules.active).toEqual([
        { id: ruleId, kind: 'forbidden_word', text: 'cheap', why: 'We are not the cheapest.' },
      ])
      expect((await overview()).factsRules).toMatchObject({ activeFacts: 1, activeRules: 1 })
      const replaced = await owner.request('POST', `${base()}/facts/${factId}/replace`, {
        body: { statement: 'Open since 2018.', reviewDate },
      })
      expect(replaced.status).toBe(200)
      const { factId: newId } = factChangedReply.parse(replaced.json)
      const retired = await owner.request('POST', `${base()}/facts/${newId}/retire`, { body: {} })
      expect(retired.status).toBe(200)
      expect(factChangedReply.parse(retired.json)).toEqual({ factId: newId })
      const off = await owner.request('POST', `${base()}/rules/${ruleId}/turn-off`, { body: {} })
      expect(off.status).toBe(200)
      expect(ruleChangedReply.parse(off.json)).toEqual({ ruleId })
      // A job waiting on a question carries its id.
      expect(
        factsRulesReply.parse({
          job: { state: 'waiting_for_answer', questionId: ruleId },
          facts: { suggestions: [], active: [] },
          rules: { suggestions: [], active: [] },
        }).job?.questionId,
      ).toBe(ruleId)
    })
  })

  it('refuses a reply with an unexpected shape, so the schemas are not vacuous', () => {
    expect(() => statusReply.parse({ killSwitch: { active: 'yes', scopes: [] } })).toThrow()
    expect(() =>
      modelCallReviewReply.parse({ items: [{ id: 'x', cost: { usdMicros: 5, inrMicros: 6 } }] }),
    ).toThrow()
  })
})
