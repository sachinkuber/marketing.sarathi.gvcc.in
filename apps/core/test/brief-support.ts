import { agentFilesHash } from '@mkt/db'
import {
  BASELINE_NEEDED,
  type StrategistInput,
  type StrategyBrief,
  type StrategyBriefResult,
} from '@mkt/shared'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { registerStrategistHandlers } from '../src/agents/register.ts'
import { postResult, type JobsDeps } from '../src/jobs/service.ts'
import { registerBriefChangeHandler } from '../src/onboarding/brief.ts'
import { claim } from './summary-support.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

// Shared by the M11 brief tests of Task 7 (ask for changes, invalidation): a stack with the strategist's result
// handler and its change handler registered, a live strategist release, a platform owner, a brand admin and an
// approver, and the steps that bring a brand to a brief waiting for approval.

const PASSWORD = 'correct horse battery'
const DIR = fileURLToPath(new URL('../../../agents/strategist', import.meta.url))
const TYPE = 'strategy_brief.v1'
const LEAD = ['Owners of new cars', 'Fleet managers', 'Detailing studios']

export const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

export interface MadeBrief {
  brandId: string
  factId: string
  runId: string
  itemId: string
  versionId: string
  hash: string
  state: string
}

export interface BriefWorld {
  stack: Stack
  jobs: JobsDeps
  ownerId: string
  adminId: string
  approverId: string
  owner: TestClient
  admin: TestClient
  approver: TestClient
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  q(sql: string, params?: unknown[]): Promise<any[]>
  api(brandId: string, path?: string): string
  contentApi(brandId: string, path: string): string
  fresh(opts?: { team?: boolean }): Promise<{ brandId: string; factId: string }>
  settle(brandId: string): Promise<void>
  started(brandId: string): Promise<{ runId: string; jobId: string; revision: number }>
  jobOfRun(runId: string): Promise<string>
  inputOf(jobId: string): Promise<StrategistInput>
  post(jobId: string, body: unknown): Promise<unknown>
  result(factIds: string[], statement?: string): StrategyBriefResult
  currentBrief(brandId: string): Promise<{ itemId: string; versionId: string; hash: string; state: string }>
  stateOf(versionId: string): Promise<string>
  stepOf(brandId: string): Promise<string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  overview(brandId: string): Promise<any>
  withBrief(opts?: { team?: boolean }): Promise<MadeBrief>
  platformOwners(): Promise<string[]>
}

const brief = (factIds: string[], statement: string): StrategyBrief => ({
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

// `tag` keeps the e-mail addresses and brand slugs of one test file apart.
export async function briefWorld(tag: string): Promise<BriefWorld> {
  const stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('withQueue')
  const jobs = stack.jobs
  registerStrategistHandlers(jobs.results, jobs)
  registerBriefChangeHandler(stack.changeHandlers, jobs)
  const ownerId = await addUser(stack, {
    email: `owner@${tag}.test`,
    password: PASSWORD,
    platformOwner: true,
  })
  const home = await addBrand(stack, `${tag}-team`)
  const adminId = await addUser(stack, {
    email: `admin@${tag}.test`,
    password: PASSWORD,
    role: 'brand_admin',
    brandId: home,
  })
  const approverId = await addUser(stack, {
    email: `approver@${tag}.test`,
    password: PASSWORD,
    role: 'approver',
    brandId: home,
  })
  const owner = (await enrolledClient(stack, `owner@${tag}.test`, PASSWORD)).client
  const admin = (await enrolledClient(stack, `admin@${tag}.test`, PASSWORD)).client
  const approver = (await enrolledClient(stack, `approver@${tag}.test`, PASSWORD)).client
  await stack.db.admin.query(
    `insert into app.agent_definition_version (agent, version, model, effort, files_hash, live)
     values ('strategist', 1, 'claude-sonnet-5-5', 'medium', $1, true)`,
    [agentFilesHash(DIR)],
  )

  let brands = 0
  const q = async (sql: string, params: unknown[] = []) => (await stack.db.admin.query(sql, params)).rows
  const api = (brandId: string, path = '') => `/api/v1/brands/${brandId}/onboarding${path}`
  const contentApi = (brandId: string, path: string) => `/api/v1/brands/${brandId}/content${path}`

  // A brand at brief choices, with a profile and one fact the owner confirmed through the API. `team` makes the
  // brand admin and the approver members of the brand.
  const fresh = async (opts: { team?: boolean } = {}) => {
    const brandId = await addBrand(stack, `${tag}-${(brands += 1)}`)
    await q(`insert into app.onboarding (brand_id, step, intake) values ($1, 'brief_choices', $2::jsonb)`, [
      brandId,
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

  // The lead audience, accepted: the brief's choicesMade names it.
  const settle = async (brandId: string) => {
    const options = LEAD.map((value, i) => ({ value, tradeOff: `Trade-off ${i + 1}.`, recommended: i === 0 }))
    const made = await q(
      `insert into app.suggestion (brand_id, step, key, proposed, why, confidence, options)
       values ($1, 'choice', 'lead_audience', $2::jsonb, 'It decides the brief.', 'assumed', $3::jsonb)
       returning id`,
      [
        brandId,
        JSON.stringify({ question: 'Which lead audience?', value: LEAD[0] }),
        JSON.stringify(options),
      ],
    )
    const reply = await owner.request('POST', api(brandId, `/suggestions/${made[0].id}/decision`), {
      body: { decision: 'accepted' },
    })
    expect(reply.status, JSON.stringify(reply.json)).toBe(200)
  }

  const started = async (brandId: string) => {
    const reply = await owner.request('POST', api(brandId, '/brief'), { body: {} })
    expect(reply.status, JSON.stringify(reply.json)).toBe(200)
    return reply.json as { runId: string; jobId: string; revision: number }
  }
  const jobOfRun = async (runId: string) =>
    (await q('select job_id from app.job_input where run_id = $1', [runId]))[0].job_id as string
  const inputOf = async (jobId: string): Promise<StrategistInput> =>
    (await q('select input from app.job_input where job_id = $1', [jobId]))[0].input
  const post = async (jobId: string, body: unknown) =>
    postResult(jobs, await claim(stack, jobs, jobId), { type: TYPE, result: body })
  const result = (factIds: string[], statement = 'The coating people of Pune.'): StrategyBriefResult => ({
    brief: brief(factIds, statement),
    ask: null,
  })

  const currentBrief = async (brandId: string) => {
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
  // A brand with a brief waiting for approval, citing its one fact.
  const withBrief = async (opts: { team?: boolean } = {}): Promise<MadeBrief> => {
    const made = await fresh(opts)
    await settle(made.brandId)
    const { runId, jobId } = await started(made.brandId)
    await post(jobId, result([made.factId]))
    return { ...made, runId, ...(await currentBrief(made.brandId)) }
  }
  const platformOwners = async () =>
    (await q('select app.platform_owner_ids() as id')).map((r) => r.id as string).sort()

  return {
    stack,
    jobs,
    ownerId,
    adminId,
    approverId,
    owner,
    admin,
    approver,
    q,
    api,
    contentApi,
    fresh,
    settle,
    started,
    jobOfRun,
    inputOf,
    post,
    result,
    currentBrief,
    stateOf,
    stepOf,
    overview,
    withBrief,
    platformOwners,
  }
}
