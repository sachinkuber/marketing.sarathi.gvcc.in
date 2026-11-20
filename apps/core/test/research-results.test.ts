import { agentFilesHash, withBrand } from '@mkt/db'
import {
  researchMergeInputSchema,
  type ResearchGroupResult,
  type ResearchMergeInput,
  type ResearchResult,
} from '@mkt/shared'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerResearchHandlers } from '../src/agents/register.ts'
import { markDead, requeueJob } from '../src/jobs/dead.ts'
import { postResult, startAttempt, type JobsDeps } from '../src/jobs/service.ts'
import { verifyAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'
import { readOverview, startResearch } from '../src/onboarding/research.ts'
import { gradeConfidence, type GradedSource } from '../src/onboarding/sources.ts'
import { decideSuggestion } from '../src/onboarding/suggestions.ts'
import { addBrand, addUser, createStack, type Stack } from './support.ts'

// Task 9: research results become profile suggestions (spec 5, 6, 8.2; rulings R10, R22, R22a).

const PASSWORD = 'correct horse battery'
const dir = (name: string) => fileURLToPath(new URL(`../../../agents/${name}`, import.meta.url))
const INTAKE = {
  website: 'https://aztek.example/',
  socials: { instagram: 'https://www.instagram.com/aztek' },
  competitors: [{ name: 'Rival', website: 'https://rival.example/' }],
}

let stack: Stack
let jobs: JobsDeps
let ownerId: string
let brands = 0

const q = async (sql: string, params: unknown[] = []) => (await stack.db.admin.query(sql, params)).rows

type Source = ResearchGroupResult['sources'][number]
type Finding = ResearchGroupResult['findings'][number]
const page = (
  ref: string,
  kind: Source['kind'],
  address: string,
  extract = `Text of ${address}`,
): Source => ({
  ref,
  kind,
  address,
  documentId: null,
  result: 'read',
  extract,
  flagged: null,
})
const finding = (
  key: Finding['key'],
  refs: string[],
  confidence: Finding['confidence'] = 'found',
): Finding => ({
  key,
  proposed: `The ${key.replace(/_/g, ' ')}`,
  why: `The sources name the ${key.replace(/_/g, ' ')}.`,
  sourceRefs: refs,
  confidence,
  conflict: false,
})
const GROUP_RESULTS: Record<string, ResearchGroupResult> = {
  site: {
    group: 'site',
    sources: [
      page('s1', 'site', 'https://aztek.example/'),
      page('s2', 'site', 'https://aztek.example/contact'),
    ],
    findings: [finding('business_name', ['s1']), finding('contact_points', ['s2'])],
    unsettled: [{ key: 'price_position', why: 'No prices on the site.' }],
  },
  social: {
    group: 'social',
    sources: [page('s1', 'social', 'https://www.instagram.com/aztek')],
    findings: [finding('social_presence', ['s1'])],
    unsettled: [],
  },
  visibility: {
    group: 'visibility',
    sources: [page('s1', 'search', 'https://news.example/aztek')],
    findings: [finding('search_visibility', ['s1'], 'assumed')],
    unsettled: [],
  },
  competitors: {
    group: 'competitors',
    sources: [page('s1', 'competitor', 'https://rival.example/')],
    findings: [finding('competitors', ['s1'], 'assumed')],
    unsettled: [],
  },
}

async function newBrand(): Promise<string> {
  const brandId = await addBrand(stack, `research-results-${(brands += 1)}`)
  await q(`insert into app.onboarding (brand_id, intake) values ($1, $2::jsonb)`, [
    brandId,
    JSON.stringify(INTAKE),
  ])
  return brandId
}

async function addDocument(brandId: string, name: string): Promise<string> {
  const made = await q(
    `insert into app.brand_document (brand_id, file_name, media_type, bytes, size_bytes, sha256, uploaded_by)
     values ($1, $2, 'application/pdf', '\\x255044462d', 5, 'h', $3) returning id`,
    [brandId, name, ownerId],
  )
  return made[0].id as string
}

// Starts research and returns the run and its group jobs by group name.
async function begin(brandId: string): Promise<{ runId: string; group: Record<string, string> }> {
  const { runId } = await startResearch(jobs.pool, jobs, { brandId, actor: { userId: ownerId } })
  const rows = await q(`select job_id, input->>'group' as "group" from app.job_input where run_id = $1`, [
    runId,
  ])
  return { runId, group: Object.fromEntries(rows.map((r) => [r.group as string, r.job_id as string])) }
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

const post = async (jobId: string, type: string, result: unknown, claims?: AttemptClaims) =>
  postResult(jobs, claims ?? (await claim(jobId)), { type, result })
const postGroup = (jobId: string, result: ResearchGroupResult, claims?: AttemptClaims) =>
  post(jobId, 'research_group.v1', result, claims)
const kill = async (jobId: string) => {
  await q(`update pgboss.job set state = 'failed' where id = $1`, [jobId])
  await markDead(jobs, jobId)
}
const runState = async (runId: string) =>
  (await q('select state from app.run where id = $1', [runId]))[0].state
const mergeJobs = (runId: string) =>
  q(
    `select job_id, input, agent, files_hash, class, outcome, finished_at from app.job_input
      where run_id = $1 and expected_result_type = 'research.v1'`,
    [runId],
  )

// Every group of the run posts its default result; the merge job's input comes back.
async function allGroupsDone(
  run: { runId: string; group: Record<string, string> },
  results: Partial<Record<string, ResearchGroupResult>> = {},
): Promise<{ jobId: string; input: ResearchMergeInput }> {
  for (const name of ['site', 'social', 'visibility', 'competitors']) {
    await postGroup(run.group[name]!, results[name] ?? GROUP_RESULTS[name]!)
  }
  const merge = await mergeJobs(run.runId)
  expect(merge).toHaveLength(1)
  return { jobId: merge[0].job_id, input: merge[0].input }
}

// A merge result as the merge agent would give it: each finding becomes one suggestion.
function mergeFrom(input: ResearchMergeInput): ResearchResult {
  return {
    suggestions: input.groups.flatMap((g) =>
      g.findings.map((f) => ({
        key: f.key,
        proposed: f.proposed,
        why: f.why,
        sourceIds: f.sourceIds,
        confidence: f.confidence,
      })),
    ),
    gaps: [{ key: 'price_position', why: 'No prices were found.' }],
  }
}
const sourceIdOf = (input: ResearchMergeInput, address: string): string =>
  input.groups.flatMap((g) => g.sources).find((s) => s.address === address)!.id

// A full research run: groups, merge, suggestions. Returns the run and its open suggestions by key.
async function fullRun(
  brandId: string,
  shape: (input: ResearchMergeInput) => ResearchResult = mergeFrom,
): Promise<{ runId: string; byKey: Record<string, string> }> {
  const run = await begin(brandId)
  const merge = await allGroupsDone(run)
  const answer = await post(merge.jobId, 'research.v1', shape(merge.input))
  expect(answer.status).toBe('applied')
  const rows = await q(`select id, key from app.suggestion where brand_id = $1 and run_id = $2`, [
    brandId,
    run.runId,
  ])
  return { runId: run.runId, byKey: Object.fromEntries(rows.map((r) => [r.key as string, r.id as string])) }
}

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  registerResearchHandlers(jobs.results, jobs.settled!, jobs)
  ownerId = await addUser(stack, { email: 'owner@rr.test', password: PASSWORD, platformOwner: true })
  for (const agent of ['research', 'research_merge']) {
    await q(
      `insert into app.agent_definition_version (agent, version, model, effort, files_hash, live)
       values ($1, 1, 'claude-sonnet-5-5', 'low', $2, true)`,
      [agent, agentFilesHash(dir(agent))],
    )
  }
}, 120_000)
afterAll(async () => stack?.close())

describe('gradeConfidence (spec 8.2, rulings R22 and R22a)', () => {
  const read = (kind: GradedSource['kind'], address: string | null): GradedSource => ({
    kind,
    address,
    result: 'read',
  })
  type Context = { key?: string; disagree?: boolean }
  type Graded = ReturnType<typeof gradeConfidence>
  const cases: [string, GradedSource[], Graded['confidence'], Context, Graded][] = [
    [
      'a site source keeps found',
      [read('site', 'https://aztek.example/')],
      'found',
      {},
      { confidence: 'found' },
    ],
    ['a document keeps found', [read('document', null)], 'found', {}, { confidence: 'found' }],
    [
      'an owner statement keeps found',
      [{ kind: 'owner_statement', address: null, result: 'stated' }],
      'found',
      {},
      { confidence: 'found' },
    ],
    [
      'one social source lowers found to assumed',
      [read('social', 'https://www.instagram.com/aztek')],
      'found',
      {},
      { confidence: 'assumed', note: 'one source' },
    ],
    [
      'two agreeing sources at different hosts keep found',
      [read('social', 'https://www.instagram.com/aztek'), read('search', 'https://news.example/aztek')],
      'found',
      {},
      { confidence: 'found' },
    ],
    [
      'two addresses on one host, case and www. aside, are one source',
      [read('social', 'https://WWW.Instagram.com/aztek'), read('search', 'https://instagram.com/p/1')],
      'found',
      {},
      { confidence: 'assumed', note: 'one source' },
    ],
    [
      'a competitor page never counts toward found',
      [read('competitor', 'https://rival.example/'), read('search', 'https://news.example/aztek')],
      'found',
      {},
      { confidence: 'assumed', note: 'one source' },
    ],
    [
      'competitor pages at two hosts are not found',
      [read('competitor', 'https://rival.example/'), read('competitor', 'https://other.example/')],
      'found',
      {},
      { confidence: 'assumed', note: 'one source' },
    ],
    [
      'a source without a web address is never a second host',
      [read('search', 'https://news.example/aztek'), read('social', 'Instagram bio'), read('social', null)],
      'found',
      {},
      { confidence: 'assumed', note: 'one source' },
    ],
    [
      'the competitors key is never found from research',
      [read('site', 'https://aztek.example/'), read('search', 'https://news.example/aztek')],
      'found',
      { key: 'competitors' },
      { confidence: 'assumed', note: 'one source' },
    ],
    [
      'sources that disagree make found assumed',
      [read('site', 'https://aztek.example/'), read('search', 'https://news.example/aztek')],
      'found',
      { disagree: true },
      { confidence: 'assumed', note: 'sources disagree' },
    ],
    [
      'an assumed item whose sources disagree says so',
      [read('social', 'https://www.instagram.com/aztek')],
      'assumed',
      { disagree: true },
      { confidence: 'assumed', note: 'sources disagree' },
    ],
    [
      'a site page that could not be read supports nothing',
      [{ kind: 'site', address: 'https://aztek.example/', result: 'blocked' }],
      'found',
      {},
      { confidence: 'assumed', note: 'one source' },
    ],
    [
      'assumed is never raised',
      [read('site', 'https://aztek.example/'), read('document', null)],
      'assumed',
      {},
      { confidence: 'assumed' },
    ],
    [
      'unknown stays unknown',
      [read('site', 'https://aztek.example/')],
      'unknown',
      {},
      { confidence: 'unknown' },
    ],
  ]
  it.each(cases)('%s', (_name, sources, claimed, context, expected) => {
    expect(gradeConfidence(sources, claimed, context)).toEqual(expected)
  })
})

describe('group results', () => {
  it('group results store their sources and the last one starts the merge', async () => {
    const brandId = await newBrand()
    const run = await begin(brandId)
    const flagged: ResearchGroupResult = {
      ...GROUP_RESULTS.site!,
      sources: [
        GROUP_RESULTS.site!.sources[0]!,
        {
          ...page('s2', 'site', 'https://aztek.example/contact', 'c'.repeat(500)),
          flagged: { reason: `Asks an AI to [ignore] rules ${'r'.repeat(250)}` },
        },
      ],
    }
    const answer = await postGroup(run.group.site!, flagged)
    expect(answer.status).toBe('applied')
    const stored = await q(
      `select id, run_id, kind, address, document_id, result, extract from app.research_source
        where brand_id = $1 and run_id = $2 order by address`,
      [brandId, run.runId],
    )
    expect(stored.map((s) => [s.kind, s.address, s.result])).toEqual([
      ['site', 'https://aztek.example/', 'read'],
      ['site', 'https://aztek.example/contact', 'read'],
    ])
    expect(stored[0].extract).toBe('Text of https://aztek.example/')
    // A flagged source keeps its flag as a marker on the extract, at most 600 characters in all.
    expect(stored[1].extract.startsWith('[flagged: Asks an AI to ')).toBe(true)
    expect(stored[1].extract.length).toBe(600)
    // The outcome the overview reads: refs mapped to the stored ids, findings citing the ids.
    const [home, contact] = [stored[0].id, stored[1].id]
    expect(answer.status === 'applied' && answer.outcome).toEqual({
      group: 'site',
      sources: [
        { ref: 's1', id: home },
        { ref: 's2', id: contact },
      ],
      findings: [
        { ...withoutRefs(GROUP_RESULTS.site!.findings[0]!), sourceIds: [home] },
        { ...withoutRefs(GROUP_RESULTS.site!.findings[1]!), sourceIds: [contact] },
      ],
    })
    const outcome = await q('select outcome from app.job_input where job_id = $1', [run.group.site])
    expect(Object.keys(outcome[0].outcome).sort()).toEqual(['findings', 'group', 'sources'])

    await postGroup(run.group.social!, GROUP_RESULTS.social!)
    await postGroup(run.group.visibility!, GROUP_RESULTS.visibility!)
    expect(await mergeJobs(run.runId)).toHaveLength(0)
    await postGroup(run.group.competitors!, GROUP_RESULTS.competitors!)

    const merge = await mergeJobs(run.runId)
    expect(merge).toHaveLength(1)
    expect(merge[0]).toMatchObject({
      agent: 'research_merge',
      files_hash: agentFilesHash(dir('research_merge')),
      class: 'production',
    })
    const input = researchMergeInputSchema.parse(merge[0].input)
    expect(input.deadGroups).toEqual([])
    expect(input.groups.map((g) => g.group)).toEqual(['site', 'social', 'visibility', 'competitors'])
    // The merge reads the extract and the flag apart again.
    const merged = input.groups[0]!.sources.find((s) => s.id === contact)!
    expect(merged.flagged!.reason.startsWith('Asks an AI to (ignore) rules ')).toBe(true)
    expect(merged.extract).toMatch(/^c+$/)
    expect(input.groups[0]!.findings[0]!.sourceIds).toEqual([home])
    expect(await runState(run.runId)).toBe('running')
    expect((await readOverview(stack.appPool, brandId)).research?.merge).toBe('waiting')
  })

  it('a document source must be one of the documents the job was given', async () => {
    const brandId = await newBrand()
    const given = await addDocument(brandId, 'brochure.pdf')
    const run = await begin(brandId)
    const other = await addDocument(brandId, 'later.pdf')
    const documents = (documentId: string): ResearchGroupResult => ({
      group: 'documents',
      sources: [
        {
          ref: 's1',
          kind: 'document',
          address: 'brochure.pdf',
          documentId,
          result: 'read',
          extract: 'Ceramic coatings.',
          flagged: null,
        },
      ],
      findings: [finding('what_they_sell', ['s1'])],
      unsettled: [],
    })
    const claims = await claim(run.group.documents!)
    await expect(postGroup(run.group.documents!, documents(other), claims)).rejects.toMatchObject({
      status: 422,
      code: 'document_outside_job',
    })
    // A group that was given no documents cannot cite one either.
    await expect(postGroup(run.group.site!, { ...documents(given), group: 'site' })).rejects.toMatchObject({
      status: 422,
      code: 'document_outside_job',
    })
    expect(await q('select 1 from app.research_source where run_id = $1', [run.runId])).toHaveLength(0)
    expect((await postGroup(run.group.documents!, documents(given), claims)).status).toBe('applied')
    expect(await q('select document_id from app.research_source where run_id = $1', [run.runId])).toEqual([
      { document_id: given },
    ])
  })

  it('a result for another group, or one that breaks the contract, is refused', async () => {
    const brandId = await newBrand()
    const run = await begin(brandId)
    const claims = await claim(run.group.site!)
    await expect(postGroup(run.group.site!, GROUP_RESULTS.social!, claims)).rejects.toMatchObject({
      status: 422,
      code: 'result_invalid',
    })
    const broken = { ...GROUP_RESULTS.site!, findings: [finding('business_name', ['s9'])] }
    await expect(postGroup(run.group.site!, broken, claims)).rejects.toMatchObject({
      status: 422,
      code: 'result_invalid',
    })
    expect(await q('select 1 from app.research_source where run_id = $1', [run.runId])).toHaveLength(0)
  })
})

function withoutRefs(f: Finding) {
  const { sourceRefs: _refs, ...rest } = f // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest
}

describe('dead groups', () => {
  it('a dead group still lets the merge start', async () => {
    const brandId = await newBrand()
    const run = await begin(brandId)
    await postGroup(run.group.site!, GROUP_RESULTS.site!)
    await postGroup(run.group.visibility!, GROUP_RESULTS.visibility!)
    // A dead group does not fail a research run while its siblings carry on.
    await kill(run.group.competitors!)
    expect(await runState(run.runId)).toBe('running')
    expect(await mergeJobs(run.runId)).toHaveLength(0)
    await postGroup(run.group.social!, GROUP_RESULTS.social!)
    let merge = await mergeJobs(run.runId)
    expect(merge).toHaveLength(1)
    expect(merge[0].input.deadGroups).toEqual(['competitors'])
    expect(merge[0].input.groups.map((g: { group: string }) => g.group)).toEqual([
      'site',
      'social',
      'visibility',
    ])
    expect(await runState(run.runId)).toBe('running')

    // The merge settles the run, the dead group notwithstanding.
    const answer = await post(merge[0].job_id, 'research.v1', mergeFrom(merge[0].input))
    expect(answer.status).toBe('applied')
    merge = await mergeJobs(run.runId)
    expect(merge[0].finished_at).not.toBeNull()
    expect(await runState(run.runId)).toBe('succeeded')
    // And research can start again.
    expect((await begin(brandId)).runId).not.toBe(run.runId)
  })

  it('a group dying last starts the merge from the dead path', async () => {
    const brandId = await newBrand()
    const run = await begin(brandId)
    for (const name of ['site', 'visibility', 'competitors'])
      await postGroup(run.group[name]!, GROUP_RESULTS[name]!)
    await kill(run.group.social!)
    const merge = await mergeJobs(run.runId)
    expect(merge).toHaveLength(1)
    expect(merge[0].input.deadGroups).toEqual(['social'])
    expect(await runState(run.runId)).toBe('running')
    // A repeated report of the same death changes nothing.
    await markDead(jobs, run.group.social!)
    expect(await mergeJobs(run.runId)).toHaveLength(1)
    const dead = await q(`select action from audit.log where action = 'jobs.dead' and subject = $1`, [
      run.group.social,
    ])
    expect(dead).toHaveLength(1)
  })

  it('when every group is dead there is no merge and the run fails', async () => {
    const brandId = await newBrand()
    const run = await begin(brandId)
    for (const name of ['site', 'social', 'visibility']) {
      await kill(run.group[name]!)
      expect(await runState(run.runId)).toBe('running')
    }
    await kill(run.group.competitors!)
    expect(await mergeJobs(run.runId)).toHaveLength(0)
    expect(await runState(run.runId)).toBe('failed')
    expect((await readOverview(stack.appPool, brandId)).research?.state).toBe('failed')
  })

  it('a merge job that dies fails the run', async () => {
    const brandId = await newBrand()
    const run = await begin(brandId)
    const merge = await allGroupsDone(run)
    await kill(merge.jobId)
    expect(await runState(run.runId)).toBe('failed')
  })

  it('requeuing a dead group after the merge started makes no second merge', async () => {
    const brandId = await newBrand()
    const run = await begin(brandId)
    for (const name of ['site', 'visibility', 'competitors'])
      await postGroup(run.group[name]!, GROUP_RESULTS[name]!)
    await kill(run.group.social!)
    expect(await mergeJobs(run.runId)).toHaveLength(1)
    await requeueJob(jobs, brandId, run.group.social!, ownerId)
    expect((await postGroup(run.group.social!, GROUP_RESULTS.social!)).status).toBe('applied')
    expect(await mergeJobs(run.runId)).toHaveLength(1)
    expect(await runState(run.runId)).toBe('running')
  })

  it('two groups settling at the same moment start exactly one merge', async () => {
    // Two results at once, then a result and a death at once.
    for (const last of ['result', 'death'] as const) {
      const brandId = await newBrand()
      const run = await begin(brandId)
      await postGroup(run.group.site!, GROUP_RESULTS.site!)
      await postGroup(run.group.social!, GROUP_RESULTS.social!)
      const visibility = await claim(run.group.visibility!)
      const competitors = await claim(run.group.competitors!)
      await q(`update pgboss.job set state = 'failed' where id = $1`, [run.group.competitors])
      await Promise.all([
        postGroup(run.group.visibility!, GROUP_RESULTS.visibility!, visibility),
        last === 'result'
          ? postGroup(run.group.competitors!, GROUP_RESULTS.competitors!, competitors)
          : markDead(jobs, run.group.competitors!),
      ])
      const merge = await mergeJobs(run.runId)
      expect(merge).toHaveLength(1)
      expect(merge[0].input.deadGroups).toEqual(last === 'result' ? [] : ['competitors'])
    }
  })
})

describe('the merge result', () => {
  it('merge refuses a source outside its run', async () => {
    const brandId = await newBrand()
    const first = await fullRun(brandId)
    const earlier = (
      await q(`select id from app.research_source where run_id = $1 limit 1`, [first.runId])
    )[0].id as string
    const run = await begin(brandId)
    const merge = await allGroupsDone(run)
    const before = await q('select count(*)::int as n from app.suggestion where brand_id = $1', [brandId])
    for (const outside of [earlier, '0b0b0b0b-0000-4000-8000-000000000000']) {
      const result = mergeFrom(merge.input)
      result.suggestions[0]!.sourceIds = [...result.suggestions[0]!.sourceIds, outside]
      await expect(post(merge.jobId, 'research.v1', result)).rejects.toMatchObject({
        status: 422,
        code: 'source_outside_run',
      })
    }
    expect(await q('select count(*)::int as n from app.suggestion where brand_id = $1', [brandId])).toEqual(
      before,
    )
    expect((await mergeJobs(run.runId))[0].finished_at).toBeNull()
  })

  it('a found suggestion resting on one social source is stored as assumed', async () => {
    const brandId = await newBrand()
    const { byKey } = await fullRun(brandId)
    const social = (
      await q('select confidence, why from app.suggestion where id = $1', [byKey.social_presence])
    )[0]
    expect(social).toEqual({
      confidence: 'assumed',
      why: 'The sources name the social presence. (one source)',
    })
    // The brand's own site keeps found; an assumed item is left as it is; competitors are never found.
    const site = (
      await q('select confidence, why from app.suggestion where id = $1', [byKey.business_name])
    )[0]
    expect(site).toEqual({ confidence: 'found', why: 'The sources name the business name.' })
    const visibility = (
      await q('select confidence, why from app.suggestion where id = $1', [byKey.search_visibility])
    )[0]
    expect(visibility).toEqual({ confidence: 'assumed', why: 'The sources name the search visibility.' })
  })

  it('two agreeing sources at different hosts stay found', async () => {
    const brandId = await newBrand()
    const { byKey } = await fullRun(brandId, (input) => {
      const result = mergeFrom(input)
      const social = result.suggestions.find((s) => s.key === 'social_presence')!
      social.sourceIds = [
        sourceIdOf(input, 'https://www.instagram.com/aztek'),
        sourceIdOf(input, 'https://news.example/aztek'),
      ]
      const competitors = result.suggestions.find((s) => s.key === 'competitors')!
      competitors.confidence = 'found'
      competitors.sourceIds = [
        sourceIdOf(input, 'https://aztek.example/'),
        sourceIdOf(input, 'https://rival.example/'),
      ]
      const contact = result.suggestions.find((s) => s.key === 'contact_points')!
      contact.why = 'The sources disagree: the site and a listing give two numbers.'
      return result
    })
    const row = async (id: string | undefined) =>
      (await q('select confidence, why from app.suggestion where id = $1', [id]))[0]
    expect((await row(byKey.social_presence)).confidence).toBe('found')
    // The competitors key is capped at assumed, whatever its sources.
    expect(await row(byKey.competitors)).toEqual({
      confidence: 'assumed',
      why: 'The sources name the competitors. (one source)',
    })
    // A suggestion whose why says the sources disagree is assumed.
    expect(await row(byKey.contact_points)).toEqual({
      confidence: 'assumed',
      why: 'The sources disagree: the site and a listing give two numbers. (sources disagree)',
    })
  })

  it('a key whose findings conflicted is assumed with "sources disagree"', async () => {
    const brandId = await newBrand()
    const run = await begin(brandId)
    const site = structuredClone(GROUP_RESULTS.site!)
    site.findings[0]!.conflict = true
    const merge = await allGroupsDone(run, { site })
    await post(merge.jobId, 'research.v1', mergeFrom(merge.input))
    const row = (
      await q(`select confidence, why from app.suggestion where run_id = $1 and key = 'business_name'`, [
        run.runId,
      ])
    )[0]
    expect(row).toEqual({
      confidence: 'assumed',
      why: 'The sources name the business name. (sources disagree)',
    })
  })

  it('the merge result becomes open profile suggestions, the step moves to profile, and the owner is notified', async () => {
    const brandId = await newBrand()
    const run = await begin(brandId)
    const merge = await allGroupsDone(run)
    const answer = await post(merge.jobId, 'research.v1', mergeFrom(merge.input))
    expect(answer).toEqual({
      status: 'applied',
      outcome: { suggestions: 5, gaps: [{ key: 'price_position', why: 'No prices were found.' }] },
    })
    const open = await q(
      `select key, step, decision, superseded_by, run_id, source_ids from app.suggestion where brand_id = $1 order by key`,
      [brandId],
    )
    expect(open.map((s) => s.key)).toEqual([
      'business_name',
      'competitors',
      'contact_points',
      'search_visibility',
      'social_presence',
    ])
    expect(open.every((s) => s.step === 'profile' && s.decision === null && s.superseded_by === null)).toBe(
      true,
    )
    expect(open.every((s) => s.run_id === run.runId && s.source_ids.length === 1)).toBe(true)
    expect((await q('select step from app.onboarding where brand_id = $1', [brandId]))[0].step).toBe(
      'profile',
    )
    const told = await q(
      `select user_id, kind, state, subject_kind, subject_id from app.notification where brand_id = $1`,
      [brandId],
    )
    expect(told).toEqual([
      {
        user_id: ownerId,
        kind: 'research_done',
        state: 'queued',
        subject_kind: 'run',
        subject_id: run.runId,
      },
    ])
    expect(await runState(run.runId)).toBe('succeeded')
    const overview = await readOverview(stack.appPool, brandId)
    expect(overview).toMatchObject({ step: 'profile', openSuggestions: 5 })
    expect(overview.research).toMatchObject({ state: 'succeeded', merge: 'done' })
    // The suggestions are audited with ids and counts only.
    const audit = await q(
      `select detail from audit.log where action = 'onboarding.suggestions_added' and brand_id = $1`,
      [brandId],
    )
    expect(audit.map((a) => a.detail)).toEqual([{ runId: run.runId, count: 5 }])
  })
})

describe('deciding research suggestions', () => {
  const decide = (
    brandId: string,
    suggestionId: string | undefined,
    decision: 'accepted' | 'edited',
    value?: string,
  ) =>
    decideSuggestion(
      stack.appPool,
      { audit: jobs.audit },
      {
        brandId,
        suggestionId: suggestionId!,
        decision,
        ...(value === undefined ? {} : { value }),
        actor: { userId: ownerId },
      },
    )
  const items = (brandId: string, key: string) =>
    q(
      `select id, value, superseded_by from app.profile_item where brand_id = $1 and key = $2 order by created_at, id`,
      [brandId, key],
    )

  it('accepting a profile suggestion for a key already in the profile supersedes the old item', async () => {
    const brandId = await newBrand()
    const first = await fullRun(brandId)
    const p1 = (await decide(brandId, first.byKey.business_name, 'accepted')).createdId!
    const second = await fullRun(brandId)
    const p2 = (await decide(brandId, second.byKey.business_name, 'accepted')).createdId!
    expect(await items(brandId, 'business_name')).toEqual([
      { id: p1, value: 'The business name', superseded_by: p2 },
      { id: p2, value: 'The business name', superseded_by: null },
    ])
    // Editing supersedes the same way; another key is untouched.
    const third = await fullRun(brandId)
    const p3 = (await decide(brandId, third.byKey.business_name, 'edited', 'Aztek Coatings')).createdId!
    const current = await q(
      `select id, value from app.profile_item where brand_id = $1 and key = 'business_name' and superseded_by is null`,
      [brandId],
    )
    expect(current).toEqual([{ id: p3, value: 'Aztek Coatings' }])
    expect((await items(brandId, 'business_name'))[1]!.superseded_by).toBe(p3)
    const c = (await decide(brandId, third.byKey.contact_points, 'accepted')).createdId
    expect(await items(brandId, 'contact_points')).toEqual([
      { id: c, value: 'The contact points', superseded_by: null },
    ])
  })

  it('a re-run after a decision keeps the decision', async () => {
    const brandId = await newBrand()
    const first = await fullRun(brandId)
    const item = (await decide(brandId, first.byKey.business_name, 'accepted')).createdId
    const second = await fullRun(brandId)
    const row = async (id: string | undefined) =>
      (await q('select decision, superseded_by from app.suggestion where id = $1', [id]))[0]
    // The decided suggestion stays as decided; the undecided ones of the first run are replaced.
    expect(await row(first.byKey.business_name)).toEqual({ decision: 'accepted', superseded_by: null })
    expect(await row(first.byKey.contact_points)).toEqual({
      decision: null,
      superseded_by: second.byKey.contact_points,
    })
    expect(await row(second.byKey.business_name)).toEqual({ decision: null, superseded_by: null })
    expect(await items(brandId, 'business_name')).toEqual([
      { id: item, value: 'The business name', superseded_by: null },
    ])
    await withBrand(stack.appPool, brandId, async (client) => {
      const visible = await client.query(
        `select count(*)::int as n from app.suggestion where superseded_by is null`,
      )
      expect(visible.rows[0].n).toBe(10 - 4)
    })
  })
})
