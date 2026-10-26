import { prepareVersion } from '@mkt/canonical'
import { withBrand } from '@mkt/db'
import { PAYLOAD_SCHEMA, summaryPayload } from '@mkt/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerSummaryHandlers } from '../src/agents/register.ts'
import { createVersion } from '../src/content/versions.ts'
import { postResult, type JobsDeps } from '../src/jobs/service.ts'
import { BRIEF, GOOD_RESULT, checkJobOf, claim, counts, runState, startRun } from './summary-support.ts'
import { addBrand, addUser, createStack, type Stack } from './support.ts'

let stack: Stack
let jobs: JobsDeps
let brand: string
let ownerId: string
let approverId: string
let adminId: string

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  registerSummaryHandlers(jobs.results, jobs)
  brand = await addBrand(stack, 'sum-a')
  ownerId = await addUser(stack, { email: 'o@sum.test', password: 'x'.repeat(14), platformOwner: true })
  approverId = await addUser(stack, {
    email: 'ap@sum.test',
    password: 'x'.repeat(14),
    role: 'approver',
    brandId: brand,
  })
  adminId = await addUser(stack, {
    email: 'ad@sum.test',
    password: 'x'.repeat(14),
    role: 'brand_admin',
    brandId: brand,
  })
}, 120_000)
afterAll(async () => {
  await stack?.close()
})

const stateOf = async (versionId: string): Promise<string> =>
  (
    await stack.db.admin.query('select state from app.content_version_state where content_version_id = $1', [
      versionId,
    ])
  ).rows[0].state

// Runs the summary job to its result and returns what the handler answered.
async function summarised(result: unknown = GOOD_RESULT) {
  const { runId, jobId } = await startRun(jobs, brand, ownerId, BRIEF)
  const claims = await claim(stack, jobs, jobId)
  const answer = await postResult(jobs, claims, { type: 'summary.v1', result })
  return { runId, jobId, answer, claims }
}

describe('the summary result handler', () => {
  it('makes item, version 1 with the expected hash in in_checks, and queues the check job in the same run', async () => {
    const { runId, answer } = await summarised()
    expect(answer.status).toBe('applied')
    const outcome = (answer as { outcome: Record<string, string> }).outcome
    const item = await stack.db.admin.query(
      'select kind, current_version_id from app.content_item where id = $1',
      [outcome.contentItemId],
    )
    expect(item.rows[0]).toMatchObject({ kind: 'summary', current_version_id: outcome.versionId })
    const version = await stack.db.admin.query(
      'select number, hash, created_by_kind, created_by_run from app.content_version where id = $1',
      [outcome.versionId],
    )
    const expected = prepareVersion({
      ...summaryPayload(GOOD_RESULT),
      schema: PAYLOAD_SCHEMA,
      brand_id: brand,
      content_item_id: outcome.contentItemId,
    })
    expect(version.rows[0]).toMatchObject({
      number: 1,
      hash: expected.hash,
      created_by_kind: 'agent',
      created_by_run: runId,
    })
    expect(outcome.hash).toBe(expected.hash)
    expect(await stateOf(outcome.versionId!)).toBe('in_checks')
    const checkJob = await checkJobOf(stack, runId)
    expect(checkJob).toBe(outcome.checkJobId)
    const input = await stack.db.admin.query('select class, input from app.job_input where job_id = $1', [
      checkJob,
    ])
    expect(input.rows[0]).toMatchObject({ class: 'interactive', input: { versionId: outcome.versionId } })
    expect(await jobs.queue.state('interactive', checkJob!)).not.toBeNull()
    expect(await runState(stack, runId)).toBe('running')
  })

  it('refuses a result with four keywords, or other extras, 422 and no item, no version, no check job', async () => {
    const before = await counts(stack, brand)
    for (const result of [
      { summary: 'ok', keywords: ['a', 'b', 'c', 'd'] },
      { summary: 'ok', keywords: ['a', 'b', 'c'], extra: true },
      { summary: 'bad‮text', keywords: ['a', 'b', 'c'] },
      { summary: '', keywords: ['a', 'b', 'c'] },
    ]) {
      const { runId, jobId } = await startRun(jobs, brand, ownerId)
      const claims = await claim(stack, jobs, jobId)
      await expect(postResult(jobs, claims, { type: 'summary.v1', result })).rejects.toMatchObject({
        status: 422,
        code: 'result_invalid',
      })
      expect(await checkJobOf(stack, runId)).toBeUndefined()
    }
    const after = await counts(stack, brand)
    expect(after.items).toBe(before.items)
    expect(after.versions).toBe(before.versions)
    expect(after.jobs).toBe(before.jobs + 4)
  })
})

describe('the placeholder check handler', () => {
  async function checkedWith(result: unknown) {
    const first = await summarised(result)
    const outcome = (first.answer as { outcome: Record<string, string> }).outcome
    const claims = await claim(stack, jobs, outcome.checkJobId!)
    const answer = await postResult(jobs, claims, {
      type: 'placeholder_check.v1',
      result: { versionId: outcome.versionId },
    })
    return { ...first, outcome, answer }
  }
  const notifications = async (versionId: string) =>
    (
      await stack.db.admin.query(
        `select user_id from app.notification where subject_id = $1 and kind = 'approval_waiting' order by user_id`,
        [versionId],
      )
    ).rows.map((r) => r.user_id as string)

  it('a pass moves the version to awaiting_approval with one request, approvers told once, run succeeded', async () => {
    const { runId, outcome, answer } = await checkedWith(GOOD_RESULT)
    expect(answer).toMatchObject({ status: 'applied', outcome: { passed: true } })
    expect(await stateOf(outcome.versionId!)).toBe('awaiting_approval')
    const requests = await stack.db.admin.query(
      'select closed_at from app.approval_request where content_version_id = $1',
      [outcome.versionId],
    )
    expect(requests.rowCount).toBe(1)
    expect(requests.rows[0].closed_at).toBeNull()
    expect(await notifications(outcome.versionId!)).toEqual([adminId, approverId].sort())
    const check = await stack.db.admin.query(
      'select check_name, kind, passed, detail from app.check_result where content_version_id = $1',
      [outcome.versionId],
    )
    expect(check.rows).toEqual([
      {
        check_name: 'placeholder_length',
        kind: 'blocking',
        passed: true,
        detail: { summaryLength: GOOD_RESULT.summary.length, longestKeyword: 7 },
      },
    ])
    expect(await runState(stack, runId)).toBe('succeeded')
  })

  it('a 401-character summary fails the check: check_failed, a recorded failure, no request, nobody told', async () => {
    const long = { summary: 'a'.repeat(401), keywords: ['x', 'y', 'z'] }
    const { outcome, answer } = await checkedWith(long)
    expect(answer).toMatchObject({ status: 'applied', outcome: { passed: false } })
    expect(await stateOf(outcome.versionId!)).toBe('check_failed')
    const check = await stack.db.admin.query(
      'select passed from app.check_result where content_version_id = $1',
      [outcome.versionId],
    )
    expect(check.rows).toEqual([{ passed: false }])
    const requests = await stack.db.admin.query(
      'select 1 from app.approval_request where content_version_id = $1',
      [outcome.versionId],
    )
    expect(requests.rowCount).toBe(0)
    expect(await notifications(outcome.versionId!)).toEqual([])
  })

  it("the rule is the core's own: a 41-character keyword fails whatever the worker says", async () => {
    const { outcome, answer } = await checkedWith({ summary: 'fine', keywords: ['k'.repeat(41), 'y', 'z'] })
    expect(answer).toMatchObject({ outcome: { passed: false } })
    expect(await stateOf(outcome.versionId!)).toBe('check_failed')
  })

  it('a version superseded between the two jobs: the check is recorded and the state stays', async () => {
    const first = await summarised()
    const outcome = (first.answer as { outcome: Record<string, string> }).outcome
    const newer = await withBrand(stack.appPool, brand, (client) =>
      createVersion(client, jobs, {
        brandId: brand,
        contentItemId: outcome.contentItemId!,
        payload: summaryPayload({ summary: 'A newer one.', keywords: ['a', 'b', 'c'] }),
        createdBy: { kind: 'user', userId: ownerId },
      }),
    )
    expect(await stateOf(outcome.versionId!)).toBe('superseded')
    const claims = await claim(stack, jobs, outcome.checkJobId!)
    const answer = await postResult(jobs, claims, {
      type: 'placeholder_check.v1',
      result: { versionId: outcome.versionId },
    })
    expect(answer).toMatchObject({ status: 'applied', outcome: { passed: true } })
    expect(await stateOf(outcome.versionId!)).toBe('superseded')
    expect(await stateOf(newer.versionId)).toBe('draft')
    const check = await stack.db.admin.query(
      'select passed from app.check_result where content_version_id = $1',
      [outcome.versionId],
    )
    expect(check.rowCount).toBe(1)
    const requests = await stack.db.admin.query(
      'select 1 from app.approval_request where content_version_id = $1',
      [outcome.versionId],
    )
    expect(requests.rowCount).toBe(0)
  })

  it('refuses a check result that names another version than the job was given', async () => {
    const a = await summarised()
    const b = await summarised()
    const ao = (a.answer as { outcome: Record<string, string> }).outcome
    const bo = (b.answer as { outcome: Record<string, string> }).outcome
    const claims = await claim(stack, jobs, ao.checkJobId!)
    await expect(
      postResult(jobs, claims, { type: 'placeholder_check.v1', result: { versionId: bo.versionId } }),
    ).rejects.toMatchObject({ status: 422, code: 'result_invalid' })
    await expect(
      postResult(jobs, claims, { type: 'placeholder_check.v1', result: { versionId: 'nope' } }),
    ).rejects.toMatchObject({ status: 422, code: 'result_invalid' })
    expect(await stateOf(bo.versionId!)).toBe('in_checks')
  })
})

describe("repeats and the worker's word", () => {
  it('a repeated post of either result type returns the first outcome and applies nothing twice', async () => {
    const { answer, claims: sameClaims } = await summarised()
    const outcome = (answer as { outcome: Record<string, string> }).outcome
    const items = (await counts(stack, brand)).items
    expect(await postResult(jobs, sameClaims, { type: 'summary.v1', result: GOOD_RESULT })).toEqual({
      status: 'repeated',
      outcome,
    })
    expect((await counts(stack, brand)).items).toBe(items)

    const checkClaims = await claim(stack, jobs, outcome.checkJobId!)
    const body = { type: 'placeholder_check.v1', result: { versionId: outcome.versionId } }
    const first = await postResult(jobs, checkClaims, body)
    const requests = (await counts(stack, brand)).requests
    expect(await postResult(jobs, checkClaims, body)).toEqual({
      status: 'repeated',
      outcome: (first as { outcome: unknown }).outcome,
    })
    expect((await counts(stack, brand)).requests).toBe(requests)
    const checks = await stack.db.admin.query(
      'select 1 from app.check_result where content_version_id = $1',
      [outcome.versionId],
    )
    expect(checks.rowCount).toBe(1)
  })

  it('a verdict sent by the worker is refused, and the core still fails a 401-character summary', async () => {
    const first = await summarised({ summary: 'a'.repeat(401), keywords: ['x', 'y', 'z'] })
    const outcome = (first.answer as { outcome: Record<string, string> }).outcome
    const claims = await claim(stack, jobs, outcome.checkJobId!)
    await expect(
      postResult(jobs, claims, {
        type: 'placeholder_check.v1',
        result: { versionId: outcome.versionId, passed: true },
      }),
    ).rejects.toMatchObject({ status: 422, code: 'result_invalid' })
    expect(await stateOf(outcome.versionId!)).toBe('in_checks')
    expect(
      await postResult(jobs, claims, {
        type: 'placeholder_check.v1',
        result: { versionId: outcome.versionId },
      }),
    ).toMatchObject({ outcome: { passed: false } })
    expect(await stateOf(outcome.versionId!)).toBe('check_failed')
  })
})

describe('run finalisation', () => {
  it('is running after the first job and succeeded after the check', async () => {
    const { runId, answer } = await summarised()
    expect(await runState(stack, runId)).toBe('running')
    const outcome = (answer as { outcome: Record<string, string> }).outcome
    const claims = await claim(stack, jobs, outcome.checkJobId!)
    await postResult(jobs, claims, { type: 'placeholder_check.v1', result: { versionId: outcome.versionId } })
    expect(await runState(stack, runId)).toBe('succeeded')
    const run = await stack.db.admin.query('select finished_at from app.run where id = $1', [runId])
    expect(run.rows[0].finished_at).not.toBeNull()
  })
})
