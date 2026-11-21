import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agentFilesHash,
  PROFILE_KEYS,
  type ResearchGroupResult,
  type ResearchMergeInput,
  type ResearchResult,
} from '@mkt/shared'
import { sleep } from '@mkt/test-support'
import { registerResearchHandlers } from '../../core/src/agents/register.ts'
import type { JobsDeps } from '../../core/src/jobs/service.ts'
import {
  addBrand,
  addUser,
  createStack,
  enrolledClient,
  type Stack,
  type TestClient,
} from '../../core/test/support.ts'
import { RESEARCH_DIR, RESEARCH_MERGE_DIR } from '../src/agents/research.ts'
import { httpCoreClient } from '../src/core-client.ts'
import { defaultHandlers, startWorker } from '../src/main.ts'
import type { ModelClient } from '../src/model.ts'
import { standInModel } from '../src/standin.ts'

// Research end to end (spec 6, 8, 14; acceptance test 50): intake, research start, four group jobs, the merge,
// and open profile suggestions, through a real core, the queue and the worker, with a scripted model.

const PASSWORD = 'correct horse battery'
const SEARCHES = 3
const FETCHES = 2

let stack: Stack
let jobs: JobsDeps
let worker: { stop(): Promise<void> }
let owner: TestClient

type Source = ResearchGroupResult['sources'][number]
const page = (ref: string, kind: Source['kind'], address: string, extract: string): Source => ({
  ref,
  kind,
  address,
  documentId: null,
  result: 'read',
  extract,
  flagged: null,
})
const found = (
  key: ResearchGroupResult['findings'][number]['key'],
  proposed: string,
  sourceRefs: string[],
  confidence: 'found' | 'assumed' = 'found',
) => ({ key, proposed, why: `Read on ${sourceRefs.join(' and ')}.`, sourceRefs, confidence, conflict: false })

// What the scripted model answers for each group, as a research reply with a short lead-in.
const GROUP_REPLIES: Record<string, ResearchGroupResult> = {
  site: {
    group: 'site',
    sources: [
      page('s1', 'site', 'https://aztek.example/', 'Aztek makes ceramic coatings for cars and bikes.'),
      page('s2', 'site', 'https://aztek.example/contact', 'Call 020 5555 0100.'),
    ],
    findings: [
      found('business_name', 'Aztek', ['s1']),
      found('what_they_sell', 'Ceramic coatings for cars and bikes', ['s1']),
      found('contact_points', 'Phone 020 5555 0100', ['s2']),
    ],
    unsettled: [{ key: 'price_position', why: 'The site shows no prices.' }],
  },
  social: {
    group: 'social',
    sources: [page('s1', 'social', 'https://www.instagram.com/aztek', 'Ceramic coatings · Pune')],
    findings: [found('social_presence', 'Instagram, posting weekly', ['s1'])],
    unsettled: [],
  },
  visibility: {
    group: 'visibility',
    sources: [page('s1', 'search', 'https://news.example/aztek', 'Aztek opens a second studio.')],
    findings: [found('search_visibility', 'Found for its name only', ['s1'], 'assumed')],
    unsettled: [],
  },
  competitors: {
    group: 'competitors',
    sources: [page('s1', 'competitor', 'https://rival.example/', 'Rival coats cars in Pune.')],
    findings: [found('competitors', 'Rival', ['s1'], 'assumed')],
    unsettled: [],
  },
}

// The merge answer: one suggestion per finding, citing the stored source ids the merge was given.
function mergeReply(step: string): string {
  const open = '<research>\n'
  const json = step.slice(step.indexOf(open) + open.length, step.lastIndexOf('\n</research>'))
  const groups = JSON.parse(json) as ResearchMergeInput['groups']
  const suggestions = groups.flatMap((g) =>
    g.findings.map((f) => ({
      key: f.key,
      proposed: f.proposed,
      why: f.why,
      sourceIds: f.sourceIds,
      confidence: f.confidence,
    })),
  )
  const result: ResearchResult = {
    suggestions,
    gaps: PROFILE_KEYS.filter((key) => !suggestions.some((s) => s.key === key)).map((key) => ({
      key,
      why: 'Nothing read says this.',
    })),
  }
  return JSON.stringify(result)
}

function replyFor(step: string): string {
  const group = /^Research group: (\w+)\./.exec(step)?.[1]
  if (group) return `The research result:\n${JSON.stringify(GROUP_REPLIES[group])}`
  if (step.startsWith('Groups that could not be read: none.')) return mergeReply(step)
  throw new Error('The scripted model was asked something it has no answer for.')
}

// The stand-in, scripted per request. Its message id is kept short (the stand-in's own embeds the whole request,
// past the checkpoint's 200 characters). A request with the web tools is answered the way the provider answers
// one: its content blocks hold the tool uses and the text, and its usage counts the searches and fetches.
function scriptedModel(): ModelClient {
  const standIn = standInModel({ logFile: '/dev/null', replyFor })
  const uses = (name: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      type: 'server_tool_use',
      id: `srvtoolu_${name}_${i}`,
      name,
      input: {},
    }))
  let n = 0
  return {
    async send(request) {
      const reply = { ...(await standIn.send(request)), messageId: `msg_research_${(n += 1)}` }
      if (!request.tools?.length) return reply
      // The pages the reply cites were fetched in this turn (I6: a read source must be one the provider returned).
      const first = request.messages[0]?.content
      const group = /^Research group: (\w+)\./.exec(typeof first === 'string' ? first : '')?.[1]
      const fetched = (group ? (GROUP_REPLIES[group]?.sources ?? []) : []).map((s, i) => ({
        type: 'web_fetch_tool_result',
        // Every id points at a real tool use above (there are FETCHES of them).
        tool_use_id: `srvtoolu_web_fetch_${i % FETCHES}`,
        content: { type: 'web_fetch_result', url: s.address },
      }))
      return {
        ...reply,
        content: [
          ...uses('web_search', SEARCHES),
          ...uses('web_fetch', FETCHES),
          ...fetched,
          { type: 'text', text: reply.text },
        ],
        usage: { ...reply.usage, serverToolSearches: SEARCHES, serverToolFetches: FETCHES },
      }
    },
  }
}

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('the stack has no queue')
  jobs = stack.jobs
  // The stack's job table starts empty; production fills it in startServer with these same handlers.
  registerResearchHandlers(jobs.results, jobs.settled, jobs)
  // Prices and a rate dated from the service's own clock; a search costs 10,000 micro-USD.
  const today = jobs.now().toISOString().slice(0, 10)
  await stack.db.admin.query(
    `insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, search_micros, source)
     values ('claude-sonnet-5-5', $1::date - 30, 2000000, 10000000, 100000, 2500000, 10000, 'test')`,
    [today],
  )
  await stack.db.admin.query(`select app.record_fx_rate($1::date - 1, 83500000, 'test')`, [today])
  // Live releases of both research agents, with the files this worker runs (ruling R9).
  for (const [agent, dir] of [
    ['research', RESEARCH_DIR],
    ['research_merge', RESEARCH_MERGE_DIR],
  ] as const) {
    await stack.db.admin.query(
      `insert into app.agent_definition_version (agent, version, model, effort, files_hash, live)
       values ($1, 1, 'claude-sonnet-5-5', 'medium', $2, true)`,
      [agent, agentFilesHash(dir)],
    )
  }
  worker = await startWorker({
    core: httpCoreClient(stack.server.url, jobs.workerSecret),
    model: scriptedModel(),
    handlers: defaultHandlers(),
    queueUrl: stack.db.urlFor('queue'),
    workerId: 'in-process',
    classes: ['production'],
    processesPerClass: 1,
    superviseIntervalSeconds: 1,
  })
}, 120_000)

afterAll(async () => {
  await worker?.stop()
  await stack?.close()
})

const q = async (sql: string, params: unknown[] = []) => (await stack.db.admin.query(sql, params)).rows

describe('research end to end', () => {
  it('intake, research start, four group jobs, the merge, then open suggestions, with each call costed with its searches', async () => {
    const brand = await addBrand(stack, 'research-e2e')
    const ownerId = await addUser(stack, { email: 'o@re2e.test', password: PASSWORD, platformOwner: true })
    owner = (await enrolledClient(stack, 'o@re2e.test', PASSWORD)).client
    const base = `/api/v1/brands/${brand}/onboarding`

    const intake = await owner.request('PUT', `${base}/intake`, {
      body: {
        website: 'https://aztek.example/',
        socials: { instagram: 'https://www.instagram.com/aztek' },
        competitors: [{ name: 'Rival', website: 'https://rival.example/' }],
      },
    })
    expect(intake.status).toBe(200)
    const started = await owner.request('POST', `${base}/research`)
    expect(started.status).toBe(200)
    const { runId } = started.json as { runId: string; jobIds: string[] }

    const end = Date.now() + 120_000
    let overview = (await owner.request('GET', base)).json
    while (overview.research.state === 'running' && Date.now() < end) {
      await sleep(500)
      overview = (await owner.request('GET', base)).json
    }
    expect(overview.research.state).toBe('succeeded')
    expect(overview.step).toBe('profile')
    expect(overview.research.merge).toBe('done')
    expect(
      overview.research.groups.map(
        (g: { group: string; state: string; searches: number; fetches: number }) => [
          g.group,
          g.state,
          g.searches,
          g.fetches,
        ],
      ),
    ).toEqual([
      ['site', 'done', SEARCHES, FETCHES],
      ['social', 'done', SEARCHES, FETCHES],
      ['visibility', 'done', SEARCHES, FETCHES],
      ['competitors', 'done', SEARCHES, FETCHES],
    ])
    expect(overview.research.groups[0].sources).toHaveLength(2)

    // Four group jobs on the research agent's files, then one merge job on the merge agent's, in the same run.
    const jobRows = await q(
      `select expected_result_type as type, agent, files_hash from app.job_input where run_id = $1`,
      [runId],
    )
    expect(jobRows.filter((r) => r.type === 'research_group.v1')).toHaveLength(4)
    expect(jobRows.filter((r) => r.type === 'research.v1')).toEqual([
      { type: 'research.v1', agent: 'research_merge', files_hash: agentFilesHash(RESEARCH_MERGE_DIR) },
    ])

    // Each research call is costed with its searches (10,000 micro-USD each) on top of its tokens (7,000); the
    // merge makes no search. INR at 83.5 per USD.
    const calls = await q(
      `select j.expected_result_type as type, m.status, m.server_tool_searches, m.server_tool_fetches,
              m.usd_micros::text as usd, m.inr_micros::text as inr,
              (select l.usd_micros::text from app.cost_ledger l where l.model_call_id = m.id) as ledger
         from app.model_call m join app.job_input j on j.job_id = m.job_id
        where m.run_id = $1`,
      [runId],
    )
    expect(calls).toHaveLength(5)
    const research = calls.filter((c) => c.type === 'research_group.v1')
    expect(research).toHaveLength(4)
    for (const call of research) {
      expect(call).toMatchObject({
        status: 'succeeded',
        server_tool_searches: SEARCHES,
        server_tool_fetches: FETCHES,
        usd: String(7000 + SEARCHES * 10000),
        inr: String((7000 + SEARCHES * 10000) * 83.5),
        ledger: String(7000 + SEARCHES * 10000),
      })
    }
    expect(calls.find((c) => c.type === 'research.v1')).toMatchObject({
      status: 'succeeded',
      server_tool_searches: 0,
      usd: '7000',
      inr: '584500',
    })
    expect(overview.cost.usdMicros).toBe(String(4 * (7000 + SEARCHES * 10000) + 7000))

    // Open profile suggestions, each with its sources; graded by the core (one social source is not found).
    const listed = await owner.request('GET', `${base}/suggestions?step=profile`)
    expect(listed.status).toBe(200)
    const suggestions = listed.json.suggestions as {
      key: string
      confidence: string
      why: string
      decision: string | null
      sources: { address: string | null }[]
    }[]
    expect(suggestions.map((s) => s.key).sort()).toEqual([
      'business_name',
      'competitors',
      'contact_points',
      'search_visibility',
      'social_presence',
      'what_they_sell',
    ])
    expect(suggestions.every((s) => s.decision === null && s.sources.length > 0)).toBe(true)
    const byKey = Object.fromEntries(suggestions.map((s) => [s.key, s]))
    expect(byKey.business_name!.confidence).toBe('found')
    expect(byKey.business_name!.sources[0]!.address).toBe('https://aztek.example/')
    expect(byKey.social_presence).toMatchObject({ confidence: 'assumed', why: 'Read on s1. (one source)' })
    expect(byKey.competitors!.confidence).toBe('assumed')
    expect(overview.openSuggestions).toBe(6)

    // The owner is told research is done.
    expect(
      await q(`select user_id, kind from app.notification where brand_id = $1 and kind = 'research_done'`, [
        brand,
      ]),
    ).toEqual([{ user_id: ownerId, kind: 'research_done' }])
    expect((await q('select ok from audit.verify_chain($1)', [brand]))[0].ok).toBe(true)
  }, 180_000)
})
