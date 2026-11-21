import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { sleep } from '@mkt/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { httpCoreClient } from '../../worker/src/core-client.ts'
import { startWorker } from '../../worker/src/main.ts'
import type { ModelClient } from '../../worker/src/model.ts'
import type { JobHandler } from '../../worker/src/runner.ts'
import { createJob, createRun, type JobsDeps } from '../src/jobs/service.ts'
import { releaseHeldJobs } from '../src/killswitch/release.ts'
import { releaseSwitch, setSwitch } from '../src/killswitch/service.ts'
import { jobState, remindAgentQuestions } from '../src/onboarding/agent-questions.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

// Task 2 of M10 (spec 9, test 47): an agent that cannot settle something asks the owner instead of guessing. The
// job waits in `waiting_for_answer` (not failed, not dead, its run still running); the answer is an owner statement
// and starts the job again as a new attempt that sees it; an unanswered question is reminded every 72 hours.

const PASSWORD = 'correct horse battery'
const RESULT_TYPE = 'test.asks'
const HOUR = 3_600_000
const QUESTION = {
  question: 'Which city is the main shop in?',
  why: 'The site names Pune and Nashik, and the brief needs one home city.',
  options: ['Pune', 'Nashik'],
  suggested: 'Pune',
}

let stack: Stack
let jobs: JobsDeps
let definitionId: string
let brandId: string
let ownerId: string
let secondOwnerId: string
let owner: TestClient
let admin: TestClient
// The clock the core's timer routes read (the approvals tick); null: the real time.
let clockAt: Date | null = null

const q = async (sql: string, params: unknown[] = []) => (await stack.db.admin.query(sql, params)).rows

// The stand-in model counts the requests it is sent, per job (the job id is the request's only message).
const sent = new Map<string, number>()
const model: ModelClient = {
  async send(request) {
    const jobId = request.messages[0]!.content as string
    sent.set(jobId, (sent.get(jobId) ?? 0) + 1)
    return {
      text: `read:${jobId}`,
      messageId: `msg_${Math.random().toString(36).slice(2, 10)}`,
      requestId: null,
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
  },
}

// One paid step, then a question while there is no answer; with the answer, the result carries what it was told.
const asker: JobHandler = async (ctx) => {
  const read = await ctx.modelStep('read', {
    model: 'test-model',
    messages: [{ role: 'user', content: ctx.jobId }],
    maxTokens: 10,
  })
  if (ctx.answers.length === 0) await ctx.ask(QUESTION)
  return { type: RESULT_TYPE, result: { text: read.text, answers: ctx.answers } }
}

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true, clock: { now: () => clockAt ?? new Date() } })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  jobs.results.set(RESULT_TYPE, async (_client, ctx) => ctx.result)
  definitionId = await seedDefinition(stack.db)
  brandId = await addBrand(stack, 'agent-questions')
  ownerId = await addUser(stack, { email: 'owner@aq.test', password: PASSWORD, platformOwner: true })
  secondOwnerId = await addUser(stack, { email: 'second@aq.test', password: PASSWORD, platformOwner: true })
  await addUser(stack, { email: 'admin@aq.test', password: PASSWORD, role: 'brand_admin', brandId })
  owner = (await enrolledClient(stack, 'owner@aq.test', PASSWORD)).client
  admin = (await enrolledClient(stack, 'admin@aq.test', PASSWORD)).client
  // A price and a rate, so each paid step writes a cost ledger row the tests can count.
  await q(
    `insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, source)
     values ('test-model', current_date - 30, 1000000, 5000000, 100000, 1250000, 'test')`,
  )
  await q(`select app.record_fx_rate(current_date - 1, 83500000, 'test')`)
}, 120_000)
afterAll(async () => {
  await stack?.close()
})

// Interactive jobs are the real worker's; production jobs are claimed by hand (no worker serves that class).
async function newJob(jobClass: 'interactive' | 'production'): Promise<{ runId: string; jobId: string }> {
  return withBrand(stack.appPool, brandId, async (client) => {
    const runId = await createRun(client, brandId, {
      agent: 'test-agent',
      definitionVersionId: definitionId,
      startedByKind: 'system',
      startedById: null,
    })
    const jobId = await createJob(client, jobs, brandId, {
      runId,
      jobClass,
      input: {},
      expectedResultType: RESULT_TYPE,
    })
    return { runId, jobId }
  })
}

function worker(method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  return fetch(`${stack.server.url}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Worker ${jobs.workerSecret}`,
      ...(token ? { 'x-attempt-token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const currentQueueRow = async (jobId: string) =>
  (await q('select coalesce(queue_id, job_id) as id from app.job_control where job_id = $1', [jobId]))[0]!
    .id as string

// Plays a worker's claim of the job's current queue row, then starts an attempt through the worker route.
async function claim(jobId: string, workerId = 'w1') {
  const queueId = await currentQueueRow(jobId)
  await q(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [queueId])
  const res = await worker('POST', `/worker/jobs/${jobId}/attempts`, undefined, { workerId, queueId })
  return { status: res.status, body: await res.json() }
}

async function claimed(jobId: string): Promise<string> {
  const started = await claim(jobId)
  if (started.status !== 200 || !started.body.token) throw new Error(`no attempt: ${JSON.stringify(started)}`)
  return started.body.token as string
}

const raise = (jobId: string, token: string, body: unknown = QUESTION) =>
  worker('POST', `/worker/jobs/${jobId}/question`, token, body)

async function raised(jobId: string): Promise<string> {
  const res = await raise(jobId, await claimed(jobId))
  if (res.status !== 201) throw new Error(`not raised: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { questionId: string }).questionId
}

const answer = (questionId: string, text: unknown, client: TestClient = owner) =>
  client.request('POST', `/api/v1/brands/${brandId}/onboarding/agent-questions/${questionId}/answer`, {
    body: { answer: text },
  })

const questionsOf = (jobId: string) =>
  q('select * from app.agent_question where job_id = $1 order by created_at, id', [jobId])
const attemptsOf = (jobId: string) =>
  q('select attempt_number, state, ended_at from app.job_attempt where job_id = $1 order by attempt_number', [
    jobId,
  ])
const queueRows = async (jobId: string) =>
  (await q(`select state from pgboss.job where data->>'jobId' = $1 order by created_on`, [jobId])).map(
    (r) => r.state as string,
  )
const runStateOf = async (runId: string) =>
  (await q('select state from app.run where id = $1', [runId]))[0]!.state as string
const auditOf = (action: string, questionId: string) =>
  q('select actor_id, detail from audit.log where action = $1 and subject = $2', [action, questionId])
const paid = async (jobId: string) => {
  const [row] = await q(
    `select (select count(*)::int from app.model_call where job_id = $1) as calls,
            (select count(*)::int from app.cost_ledger l join app.model_call m on m.id = l.model_call_id
              where m.job_id = $1) as ledger`,
    [jobId],
  )
  return { calls: row!.calls as number, ledger: row!.ledger as number, sent: sent.get(jobId) ?? 0 }
}

const isFinished = async (jobId: string) =>
  (await q('select finished_at from app.job_input where job_id = $1', [jobId]))[0]!.finished_at !== null

// The job's state as the onboarding screens read it, from its rows.
async function stateOf(jobId: string) {
  const [row] = await q(
    `select i.finished_at is not null as finished, c.dead_at is not null as dead, c.cancel_requested as cancelled,
            (select count(*)::int from app.job_attempt a where a.job_id = i.job_id) as attempts,
            exists (select 1 from app.agent_question x where x.job_id = i.job_id and x.answer is null) as "openQuestion"
       from app.job_input i join app.job_control c on c.job_id = i.job_id where i.job_id = $1`,
    [jobId],
  )
  return jobState(
    row as { finished: boolean; dead: boolean; cancelled: boolean; attempts: number; openQuestion: boolean },
  )
}

async function until(check: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error('condition not reached in time')
}

// The job has asked and the worker has let its queue row complete.
async function waitingOn(jobId: string): Promise<Record<string, unknown>> {
  await until(
    async () =>
      (await questionsOf(jobId)).length === 1 && (await queueRows(jobId)).every((s) => s === 'completed'),
  )
  return (await questionsOf(jobId))[0]!
}

describe('with a real worker', () => {
  let running: { stop(): Promise<void> } | null = null
  beforeAll(async () => {
    running = await startWorker({
      core: httpCoreClient(stack.server.url, jobs.workerSecret),
      model,
      handlers: { [RESULT_TYPE]: { handler: asker, agent: null, filesHash: null } },
      queueUrl: stack.db.urlFor('queue'),
      workerId: 'aq-worker',
      classes: ['interactive'],
      processesPerClass: 1,
      superviseIntervalSeconds: 1,
      reconcileIntervalSeconds: 3600,
      log: () => {},
    })
  }, 60_000)
  afterAll(async () => {
    await running?.stop()
  })

  it('a raised question puts the job in waiting_for_answer and the run stays running (test 47)', async () => {
    const { runId, jobId } = await newJob('interactive')
    const question = await waitingOn(jobId)
    expect(question).toMatchObject({
      brand_id: brandId,
      run_id: runId,
      job_id: jobId,
      ...QUESTION,
      answer: null,
      answered_by: null,
      answered_at: null,
      reminded_at: null,
      source_id: null,
    })
    // Not failed, not dead, not running: the attempt that asked has ended, no other started, and the queue row
    // completed (so the queue neither retries it nor lists it dead).
    expect(await stateOf(jobId)).toBe('waiting_for_answer')
    const [job] = await q(
      `select i.finished_at, c.dead_at, c.cancel_requested from app.job_input i
         join app.job_control c on c.job_id = i.job_id where i.job_id = $1`,
      [jobId],
    )
    expect(job).toEqual({ finished_at: null, dead_at: null, cancel_requested: false })
    const attempts = await attemptsOf(jobId)
    expect(attempts).toMatchObject([{ attempt_number: 1, state: 'failed' }])
    expect(attempts[0]!.ended_at).not.toBeNull()
    expect(await queueRows(jobId)).toEqual(['completed'])
    expect(await runStateOf(runId)).toBe('running')

    // Each platform owner is told, about the job; the audit entry carries ids only.
    const told = await q(
      `select user_id, subject_kind, subject_id from app.notification
        where brand_id = $1 and kind = 'agent_question' and subject_id = $2 order by user_id`,
      [brandId, jobId],
    )
    expect(told).toEqual(
      [ownerId, secondOwnerId]
        .sort()
        .map((userId) => ({ user_id: userId, subject_kind: 'job', subject_id: jobId })),
    )
    expect(await auditOf('onboarding.agent_question_raised', question.id as string)).toEqual([
      { actor_id: null, detail: { questionId: question.id, jobId } },
    ])

    // The owner's list shows it open.
    const list = await owner.request('GET', `/api/v1/brands/${brandId}/onboarding/agent-questions`)
    expect(list.status).toBe(200)
    expect(list.json.questions.find((x: { id: string }) => x.id === question.id)).toEqual({
      id: question.id,
      jobId,
      runId,
      agent: 'test-agent',
      ...QUESTION,
      createdAt: (question.created_at as Date).toISOString(),
      answer: null,
      answeredAt: null,
    })
  })

  it('the answer resumes the job as a new attempt that sees the answer', async () => {
    const { runId, jobId } = await newJob('interactive')
    const question = await waitingOn(jobId)
    const reply = await answer(question.id as string, '  Pune, near the station.  ')
    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({ questionId: question.id, requeued: true })

    await until(() => isFinished(jobId))
    const [job] = await q('select outcome from app.job_input where job_id = $1', [jobId])
    // Trimmed, as the owner's words are stored.
    expect(job!.outcome).toEqual({
      text: `read:${jobId}`,
      answers: [
        {
          question: QUESTION.question,
          why: QUESTION.why,
          options: QUESTION.options,
          answer: 'Pune, near the station.',
        },
      ],
    })
    expect(await attemptsOf(jobId)).toMatchObject([
      { attempt_number: 1, state: 'failed' },
      { attempt_number: 2, state: 'succeeded' },
    ])
    expect(await stateOf(jobId)).toBe('done')
    expect(await runStateOf(runId)).toBe('succeeded')
    // The job was sent again once, under a new queue id; both copies completed.
    await until(async () => (await queueRows(jobId)).every((s) => s === 'completed'))
    expect(await queueRows(jobId)).toEqual(['completed', 'completed'])
    expect(await currentQueueRow(jobId)).not.toBe(jobId)

    const list = await owner.request('GET', `/api/v1/brands/${brandId}/onboarding/agent-questions`)
    const shown = list.json.questions.find((x: { id: string }) => x.id === question.id)
    expect(shown).toMatchObject({ answer: 'Pune, near the station.' })
    expect(Date.parse(shown.answeredAt)).not.toBeNaN()
  })

  it('no model call is made between the question and the answer (the ledger count is unchanged)', async () => {
    const { jobId } = await newJob('interactive')
    const question = await waitingOn(jobId)
    // The one paid step before the question, costed.
    expect(await paid(jobId)).toEqual({ calls: 1, ledger: 1, sent: 1 })
    // While it waits, nothing runs it: the worker keeps polling and the timer ticks.
    await sleep(5_000)
    await worker('POST', '/worker/approvals/tick', undefined, { workerId: 'aq-worker' })
    expect(await paid(jobId)).toEqual({ calls: 1, ledger: 1, sent: 1 })
    expect(await attemptsOf(jobId)).toHaveLength(1)

    // The resumed attempt replays the saved step: the answer costs no new call either.
    expect((await answer(question.id as string, 'Pune')).status).toBe(200)
    await until(() => isFinished(jobId))
    expect(await paid(jobId)).toEqual({ calls: 1, ledger: 1, sent: 1 })
  })

  it('an answer while the agent is switched off re-queues the job, the switch holds it, and the release runs it', async () => {
    const { jobId } = await newJob('interactive')
    const question = await waitingOn(jobId)
    const target = { brandId, scope: 'agent' as const, target: 'test-agent', actor: ownerId }
    await setSwitch(stack.appPool, { audit: jobs.audit }, target)
    try {
      expect((await answer(question.id as string, 'Nashik')).status).toBe(200)
      // The new copy is claimed and turned away as held: no attempt, no model call, nothing finished.
      await until(async () => {
        const rows = await queueRows(jobId)
        return rows.length === 2 && rows.every((s) => s === 'completed')
      })
      expect(await attemptsOf(jobId)).toHaveLength(1)
      expect((await q('select held from app.job_control where job_id = $1', [jobId]))[0]!.held).toBe(true)
      expect(await stateOf(jobId)).toBe('running')
      expect(await paid(jobId)).toEqual({ calls: 1, ledger: 1, sent: 1 })
    } finally {
      await releaseSwitch(stack.appPool, { audit: jobs.audit, afterRelease: releaseHeldJobs(jobs) }, target)
    }
    await until(() => isFinished(jobId))
    const [job] = await q('select outcome from app.job_input where job_id = $1', [jobId])
    expect((job!.outcome as { answers: { answer: string }[] }).answers.map((a) => a.answer)).toEqual([
      'Nashik',
    ])
    expect(await attemptsOf(jobId)).toMatchObject([
      { attempt_number: 1, state: 'failed' },
      { attempt_number: 2, state: 'succeeded' },
    ])
  })
})

describe('without a worker (the job is claimed by hand)', () => {
  it('a second open question for the job is refused', async () => {
    const { runId, jobId } = await newJob('production')
    const token = await claimed(jobId)
    // An open question already stands for this job (the one-open rule, agent_question_one_open).
    await q(
      `insert into app.agent_question (brand_id, run_id, job_id, question, why) values ($1, $2, $3, 'First?', 'Because.')`,
      [brandId, runId, jobId],
    )
    const res = await raise(jobId, token)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('question_open')
    expect(await questionsOf(jobId)).toHaveLength(1)
    expect(await attemptsOf(jobId)).toMatchObject([{ attempt_number: 1, state: 'active' }])

    // And an attempt that has asked has ended: it cannot ask again.
    const other = await newJob('production')
    const otherToken = await claimed(other.jobId)
    expect((await raise(other.jobId, otherToken)).status).toBe(201)
    const again = await raise(other.jobId, otherToken, { ...QUESTION, question: 'Another?' })
    expect(again.status).toBe(403)
    expect((await again.json()).error.code).toBe('attempt_refused')
    expect(await questionsOf(other.jobId)).toHaveLength(1)
  })

  it('checks the question it is sent', async () => {
    const { jobId } = await newJob('production')
    const token = await claimed(jobId)
    for (const body of [
      { ...QUESTION, extra: 1 },
      { ...QUESTION, question: '' },
      { ...QUESTION, question: 'x'.repeat(501) },
      { ...QUESTION, why: 'x'.repeat(301) },
      { ...QUESTION, options: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { ...QUESTION, options: ['x'.repeat(201)] },
      { ...QUESTION, suggested: 'x'.repeat(501) },
      { question: QUESTION.question, why: QUESTION.why, options: [] },
    ]) {
      const res = await raise(jobId, token, body)
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400)
    }
    expect(await questionsOf(jobId)).toHaveLength(0)
    // No options and no suggestion is a valid question.
    expect((await raise(jobId, token, { ...QUESTION, options: [], suggested: null })).status).toBe(201)
  })

  it('a retried queue row of a waiting job starts no attempt', async () => {
    const { jobId } = await newJob('production')
    await raised(jobId)
    // The worker died after the question was stored and before its queue row completed: the queue runs the row
    // again, and the core starts no attempt and takes no second question.
    const again = await claim(jobId, 'w2')
    expect(again).toEqual({ status: 200, body: { finished: false, outcome: 'waiting_for_answer' } })
    expect(await attemptsOf(jobId)).toHaveLength(1)
    expect(await questionsOf(jobId)).toHaveLength(1)
    expect(await stateOf(jobId)).toBe('waiting_for_answer')
  })

  it("an answer to a cancelled job's question is refused", async () => {
    const ends = {
      cancelled: 'update app.job_control set cancel_requested = true where job_id = $1',
      dead: 'update app.job_control set dead_at = now() where job_id = $1',
      finished: 'update app.job_input set finished_at = now() where job_id = $1',
    }
    for (const [end, sql] of Object.entries(ends)) {
      const { jobId } = await newJob('production')
      const questionId = await raised(jobId)
      await q(sql, [jobId])
      const before = await queueRows(jobId)
      const reply = await answer(questionId, 'Pune')
      expect(reply.status, end).toBe(409)
      expect(reply.json.error.code, end).toBe('job_not_waiting')
      // Nothing was written and nothing re-queued.
      const [question] = await questionsOf(jobId)
      expect(question, end).toMatchObject({ answer: null, answered_by: null, source_id: null })
      expect(await queueRows(jobId), end).toEqual(before)
      expect(await auditOf('onboarding.agent_question_answered', questionId), end).toEqual([])
      // The list no longer offers it as open.
      const list = await owner.request('GET', `/api/v1/brands/${brandId}/onboarding/agent-questions`)
      expect(
        list.json.questions.some((x: { id: string }) => x.id === questionId),
        end,
      ).toBe(false)
    }
  })

  it('a second answer is refused (exactly one re-queue)', async () => {
    const { jobId } = await newJob('production')
    const questionId = await raised(jobId)
    await q(`update pgboss.job set state = 'completed', completed_on = now() where id = $1`, [jobId])
    const statements = () =>
      q(
        `select id, extract from app.research_source where brand_id = $1 and kind = 'owner_statement' and extract in ('One', 'Two')`,
        [brandId],
      )
    // A double click: two answers at once.
    const replies = await Promise.all([answer(questionId, 'One'), answer(questionId, 'Two')])
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409])
    expect(replies.find((r) => r.status === 409)!.json.error.code).toBe('already_answered')
    const later = await answer(questionId, 'Three')
    expect(later.status).toBe(409)
    expect(later.json.error.code).toBe('already_answered')

    const [question] = await questionsOf(jobId)
    const made = await statements()
    expect(made).toHaveLength(1)
    expect(question!.source_id).toBe(made[0]!.id)
    expect(question!.answer).toBe(made[0]!.extract)
    expect(await queueRows(jobId)).toEqual(['completed', 'created'])
    expect(await auditOf('onboarding.agent_question_answered', questionId)).toHaveLength(1)
  })

  it('the answer is an owner statement with who, when and the exact wording', async () => {
    const { runId, jobId } = await newJob('production')
    const questionId = await raised(jobId)
    const wording =
      `Pune — the shop on FC Road.\nWe opened in 1998; "since 1998" is fine to say. ${'नमस्ते '.repeat(265)}`.trim()
    expect(wording.length).toBeGreaterThan(1900)
    expect(wording.length).toBeLessThanOrEqual(2000)
    // Blank and too long are refused before anything is written.
    for (const bad of ['   ', 'x'.repeat(2001), 'a\u0000b']) {
      expect((await answer(questionId, bad)).status).toBe(400)
    }
    const reply = await answer(questionId, `  ${wording}\n`)
    expect(reply.status).toBe(200)

    const [question] = await questionsOf(jobId)
    expect(question).toMatchObject({ answer: wording, answered_by: ownerId })
    const [source] = await q('select * from app.research_source where id = $1', [question!.source_id])
    expect(source).toMatchObject({
      brand_id: brandId,
      run_id: runId,
      kind: 'owner_statement',
      result: 'stated',
      stated_by: ownerId,
      extract: wording,
      address: null,
      document_id: null,
    })
    expect((source!.read_at as Date).getTime()).toBe((question!.answered_at as Date).getTime())
    // The audit entry names who answered and carries ids only, never the wording.
    const entries = await auditOf('onboarding.agent_question_answered', questionId)
    expect(entries).toEqual([{ actor_id: ownerId, detail: { questionId, jobId } }])

    // The job's next attempt is the second, and it is given the answer.
    const next = await claim(jobId)
    expect(next.status).toBe(200)
    expect(next.body).toMatchObject({
      attemptNumber: 2,
      answers: [
        { question: QUESTION.question, why: QUESTION.why, options: QUESTION.options, answer: wording },
      ],
    })
  })

  it('an unanswered question is reminded after 72 hours and again 72 hours later, never before', async () => {
    const { jobId } = await newJob('production')
    const questionId = await raised(jobId)
    // A question whose job was cancelled waits on nothing and is never reminded.
    const cancelled = await newJob('production')
    const cancelledId = await raised(cancelled.jobId)
    await q('update app.job_control set cancel_requested = true where job_id = $1', [cancelled.jobId])
    // Moved into the past, so no question another test made is due at these times.
    const t0 = new Date('2020-03-01T00:00:00Z')
    await q('update app.agent_question set created_at = $2 where id = any($1::uuid[])', [
      [questionId, cancelledId],
      t0,
    ])
    const at = (ms: number) => new Date(t0.getTime() + ms)
    const remind = (ms: number) => remindAgentQuestions(stack.appPool, at(ms))
    const reminders = async (job: string) =>
      (
        await q(
          `select user_id, subject_kind from app.notification
            where brand_id = $1 and kind = 'agent_question_reminder' and subject_id = $2 order by created_at, user_id`,
          [brandId, job],
        )
      ).length

    expect(await remind(71 * HOUR)).toBe(0)
    expect(await remind(72 * HOUR)).toBe(0)
    expect(await reminders(jobId)).toBe(0)
    expect(await remind(72 * HOUR + 1000)).toBe(1)
    // To each platform owner.
    expect(await reminders(jobId)).toBe(2)
    expect((await questionsOf(jobId))[0]!.reminded_at).toEqual(at(72 * HOUR + 1000))
    // Not again until 72 hours after the reminder.
    expect(await remind(72 * HOUR + 1000)).toBe(0)
    expect(await remind(144 * HOUR)).toBe(0)
    expect(await remind(144 * HOUR + 1000)).toBe(0)
    expect(await reminders(jobId)).toBe(2)
    expect(await remind(144 * HOUR + 2000)).toBe(1)
    expect(await reminders(jobId)).toBe(4)

    // The timer route runs the same sweep and reports the count with the approvals counts.
    clockAt = at(216 * HOUR + 3000)
    try {
      const res = await worker('POST', '/worker/approvals/tick', undefined, { workerId: 'aq-timer' })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        reminded: 0,
        overdue: 0,
        escalated: 0,
        agentQuestionsReminded: 1,
      })
    } finally {
      clockAt = null
    }
    expect(await reminders(jobId)).toBe(6)
    // It never times out into a guess: still open, no answer, the job still waiting.
    expect((await questionsOf(jobId))[0]).toMatchObject({ answer: null, source_id: null })
    expect(await stateOf(jobId)).toBe('waiting_for_answer')
    expect(await reminders(cancelled.jobId)).toBe(0)
    expect((await questionsOf(cancelled.jobId))[0]!.reminded_at).toBeNull()
  })

  it('a brand admin gets 403', async () => {
    const { jobId } = await newJob('production')
    const questionId = await raised(jobId)
    const list = await admin.request('GET', `/api/v1/brands/${brandId}/onboarding/agent-questions`)
    expect(list.status).toBe(403)
    const reply = await answer(questionId, 'Pune', admin)
    expect(reply.status).toBe(403)
    expect((await questionsOf(jobId))[0]).toMatchObject({ answer: null })
    // The platform owner is let through on both.
    expect((await owner.request('GET', `/api/v1/brands/${brandId}/onboarding/agent-questions`)).status).toBe(
      200,
    )
    expect((await answer(questionId, 'Pune')).status).toBe(200)
  })

  it('lists the open questions first, then the 20 newest answered', async () => {
    const open: string[] = []
    for (let i = 0; i < 2; i += 1) open.push(await raised((await newJob('production')).jobId))
    const answered: string[] = []
    for (let i = 0; i < 21; i += 1) {
      const id = await raised((await newJob('production')).jobId)
      expect((await answer(id, `Answer ${i}`)).status).toBe(200)
      answered.push(id)
    }
    const list = await owner.request('GET', `/api/v1/brands/${brandId}/onboarding/agent-questions`)
    expect(list.status).toBe(200)
    const questions = list.json.questions as { id: string; answer: string | null }[]
    const firstAnswered = questions.findIndex((x) => x.answer !== null)
    expect(questions.slice(0, firstAnswered).every((x) => x.answer === null)).toBe(true)
    expect(questions.slice(firstAnswered).every((x) => x.answer !== null)).toBe(true)
    expect(open.every((id) => questions.slice(0, firstAnswered).some((x) => x.id === id))).toBe(true)
    // The newest 20 answered, newest first: the oldest of these 21 has dropped off.
    expect(questions.slice(firstAnswered).map((x) => x.id)).toEqual([...answered].reverse().slice(0, 20))
  })

  it('jobState reads waiting_for_answer only for a job that can still run', () => {
    const base = { finished: false, dead: false, cancelled: false, attempts: 1, openQuestion: true }
    expect(jobState(base)).toBe('waiting_for_answer')
    expect(jobState({ ...base, attempts: 0 })).toBe('waiting_for_answer')
    expect(jobState({ ...base, finished: true })).toBe('done')
    expect(jobState({ ...base, dead: true })).toBe('failed')
    expect(jobState({ ...base, cancelled: true })).toBe('failed')
    expect(jobState({ ...base, openQuestion: false })).toBe('running')
    expect(jobState({ ...base, openQuestion: false, attempts: 0 })).toBe('waiting')
  })
})
