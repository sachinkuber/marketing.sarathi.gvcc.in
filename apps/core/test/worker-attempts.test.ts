import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '@mkt/db'
import { seedDefinition } from '@mkt/db/testing'
import { signAttemptToken, verifyAttemptToken, type AttemptClaims } from '../src/jobs/token.ts'
import {
  createJob,
  createRun,
  requireCurrentAttempt,
  startAttempt,
  type JobsDeps,
} from '../src/jobs/service.ts'
import { addBrand, addUser, createStack, signedInClient, type Stack } from './support.ts'

const PASSWORD = 'correct horse battery'

let stack: Stack
let jobs: JobsDeps
let brandA: string
let brandB: string
let definitionId: string

const AUTH = () => `Worker ${jobs.workerSecret}`

async function makeJob(
  brandId: string,
  jobClass: 'production' | 'interactive' = 'production',
): Promise<string> {
  return withBrand(stack.appPool, brandId, async (client) => {
    const runId = await createRun(client, brandId, {
      agent: 'test-agent',
      definitionVersionId: definitionId,
      startedByKind: 'system',
      startedById: null,
    })
    return createJob(client, jobs, brandId, {
      runId,
      jobClass,
      input: { for: brandId },
      expectedResultType: 'test.echo',
    })
  })
}

// The queue's own record says a worker has claimed it. The core reads exactly this field.
async function markActive(jobId: string): Promise<void> {
  await stack.db.admin.query(`update pgboss.job set state = 'active', started_on = now() where id = $1`, [
    jobId,
  ])
}

function call(method: string, path: string, options: { token?: string; auth?: string; body?: unknown } = {}) {
  return fetch(`${stack.server.url}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.auth === undefined
        ? { authorization: AUTH() }
        : options.auth === ''
          ? {}
          : { authorization: options.auth }),
      ...(options.token ? { 'x-attempt-token': options.token } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function refusals(): Promise<{ reason: string; jobId: string }[]> {
  const { rows } = await stack.db.admin.query<{ detail: { reason: string; jobId: string } }>(
    `select detail from audit.log where action = 'worker.attempt_refused' order by at`,
  )
  return rows.map((r) => r.detail)
}

beforeAll(async () => {
  stack = await createStack({ withQueue: true, realAudit: true })
  if (!stack.jobs) throw new Error('withQueue')
  jobs = stack.jobs
  brandA = await addBrand(stack, 'attempts-a')
  brandB = await addBrand(stack, 'attempts-b')
  definitionId = await seedDefinition(stack.db)
})
afterAll(async () => {
  await stack?.close()
})

describe('starting an attempt', () => {
  it('gives the input and a token for a job a worker has claimed', async () => {
    const jobId = await makeJob(brandA)
    await markActive(jobId)
    const res = await call('POST', `/worker/jobs/${jobId}/attempts`, { body: { workerId: 'w1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      finished: false,
      attemptNumber: 1,
      input: { for: brandA },
      savedSteps: [],
      expectedResultType: 'test.echo',
    })
    expect(body.token).toMatch(/^v1\./)
  })

  it('refuses a job the queue does not show as active', async () => {
    const jobId = await makeJob(brandA)
    const res = await call('POST', `/worker/jobs/${jobId}/attempts`, { body: { workerId: 'w1' } })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('job_not_active')
  })

  it('supersedes the earlier attempt when the job is claimed again', async () => {
    const jobId = await makeJob(brandA)
    await markActive(jobId)
    const first = await (
      await call('POST', `/worker/jobs/${jobId}/attempts`, { body: { workerId: 'w1' } })
    ).json()
    const second = await (
      await call('POST', `/worker/jobs/${jobId}/attempts`, { body: { workerId: 'w2' } })
    ).json()
    expect(second.attemptNumber).toBe(2)
    const states = await stack.db.admin.query<{ attempt_number: number; state: string }>(
      'select attempt_number, state from app.job_attempt where job_id = $1 order by attempt_number',
      [jobId],
    )
    expect(states.rows).toEqual([
      { attempt_number: 1, state: 'superseded' },
      { attempt_number: 2, state: 'active' },
    ])
    expect(first.attemptId).not.toBe(second.attemptId)
  })

  it('does not know a job that does not exist', async () => {
    const res = await call('POST', `/worker/jobs/${randomUUID()}/attempts`, { body: { workerId: 'w1' } })
    expect(res.status).toBe(404)
  })
})

describe('the attempt token (acceptance tests 6, 26 and 32)', () => {
  it('test 6: a token for job A cannot read job B, in the same brand or another', async () => {
    const jobA = await makeJob(brandA)
    const sameBrand = await makeJob(brandA)
    const otherBrand = await makeJob(brandB)
    for (const j of [jobA, sameBrand, otherBrand]) await markActive(j)
    const started = await (
      await call('POST', `/worker/jobs/${jobA}/attempts`, { body: { workerId: 'w1' } })
    ).json()

    expect((await call('GET', `/worker/jobs/${jobA}/control`, { token: started.token })).status).toBe(200)
    for (const other of [sameBrand, otherBrand]) {
      const res = await call('GET', `/worker/jobs/${other}/control`, { token: started.token })
      expect(res.status).toBe(403)
      expect(JSON.stringify(await res.json())).not.toContain(brandB)
    }
    const logged = await refusals()
    const wrong = logged.filter((r) => r.reason === 'wrong_job' && r.jobId === sameBrand)
    const wrongOther = logged.filter((r) => r.reason === 'wrong_job' && r.jobId === otherBrand)
    expect(wrong.length).toBeGreaterThanOrEqual(1)
    expect(wrongOther.length).toBeGreaterThanOrEqual(1)
  })

  it('test 26: a superseded attempt is refused whatever its token says, and the refusal is recorded', async () => {
    const jobId = await makeJob(brandA)
    await markActive(jobId)
    const first = await (
      await call('POST', `/worker/jobs/${jobId}/attempts`, { body: { workerId: 'w1' } })
    ).json()
    const second = await (
      await call('POST', `/worker/jobs/${jobId}/attempts`, { body: { workerId: 'w2' } })
    ).json()
    expect((await call('GET', `/worker/jobs/${jobId}/control`, { token: first.token })).status).toBe(403)
    expect((await call('GET', `/worker/jobs/${jobId}/control`, { token: second.token })).status).toBe(200)
    expect((await refusals()).some((r) => r.reason === 'attempt_superseded' && r.jobId === jobId)).toBe(true)
  })

  it('test 32: an expired token, a tampered token and a token signed with the worker credential are refused', async () => {
    const jobId = await makeJob(brandA)
    await markActive(jobId)
    const started = await (
      await call('POST', `/worker/jobs/${jobId}/attempts`, { body: { workerId: 'w1' } })
    ).json()
    const claims = JSON.parse(
      Buffer.from(started.token.split('.')[1], 'base64url').toString(),
    ) as AttemptClaims

    // Expired: the same claims, signed correctly, with a window that has closed.
    const expired = signAttemptToken(jobs.attemptTokenSecret, { ...claims, issuedAt: 1, expiresAt: 2 })
    expect((await call('GET', `/worker/jobs/${jobId}/control`, { token: expired })).status).toBe(403)

    // Tampered: a field changed after signing.
    const [v, , s] = started.token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...claims, expiresAt: claims.expiresAt + 99_999 })).toString(
      'base64url',
    )
    expect(
      (await call('GET', `/worker/jobs/${jobId}/control`, { token: `${v}.${forged}.${s}` })).status,
    ).toBe(403)

    // Signed with the worker credential instead of the token secret.
    const wrongSecret = signAttemptToken(jobs.workerSecret, claims)
    expect((await call('GET', `/worker/jobs/${jobId}/control`, { token: wrongSecret })).status).toBe(403)

    // No token at all.
    expect((await call('GET', `/worker/jobs/${jobId}/control`)).status).toBe(403)
    const reasons = (await refusals()).map((r) => r.reason)
    expect(reasons).toEqual(expect.arrayContaining(['expired', 'bad_signature']))
  })
})

describe('the worker credential', () => {
  it('refuses a wrong credential with 401 and no detail', async () => {
    const jobId = await makeJob(brandA)
    await markActive(jobId)
    const res = await call('POST', `/worker/jobs/${jobId}/attempts`, {
      auth: 'Worker not-the-secret',
      body: { workerId: 'w1' },
    })
    expect(res.status).toBe(401)
  })

  it('refuses a real user session cookie on a worker route', async () => {
    const jobId = await makeJob(brandA)
    await markActive(jobId)
    await addUser(stack, {
      email: 'cookie@example.test',
      password: PASSWORD,
      role: 'approver',
      brandId: brandA,
    })
    const user = await signedInClient(stack, 'cookie@example.test', PASSWORD)
    expect(user.cookieHeader()).not.toBe('')
    const start = `/api/v1/worker/jobs/${jobId}/attempts`
    const control = `/api/v1/worker/jobs/${jobId}/control`

    // Cookie, Origin and request token, but no worker credential: the credential check refuses.
    expect((await user.request('POST', start, { body: { workerId: 'w1' } })).status).toBe(401)
    expect((await user.request('GET', control)).status).toBe(401)
    // Cookie and no Origin, no credential: refused at the origin guard.
    expect((await user.request('POST', start, { body: { workerId: 'w1' }, origin: null })).status).toBe(403)
    // Cookie plus a wrong credential: the Authorization header skips the origin check, the credential refuses.
    const wrong = { authorization: 'Worker x' }
    expect(
      (await user.request('POST', start, { body: { workerId: 'w1' }, origin: null, headers: wrong })).status,
    ).toBe(401)
    expect((await user.request('GET', control, { headers: wrong })).status).toBe(401)
    // Nothing was started.
    const attempts = await stack.db.admin.query('select 1 from app.job_attempt where job_id = $1', [jobId])
    expect(attempts.rowCount).toBe(0)
  })
})

describe('the attempt must be the current one when it acts', () => {
  async function started(jobId: string): Promise<AttemptClaims> {
    await markActive(jobId)
    const result = await startAttempt(jobs, jobId, 'w1')
    if (result.finished || 'outcome' in result) throw new Error('unexpected')
    const checked = verifyAttemptToken(jobs.attemptTokenSecret, result.token, Math.floor(Date.now() / 1000))
    if (!checked.ok) throw new Error('token')
    return checked.claims
  }
  const check = (claims: AttemptClaims) =>
    withBrand(stack.appPool, claims.brandId, (client) => requireCurrentAttempt(client, jobs, claims))

  it('accepts a succeeded latest attempt, and refuses an ended one as attempt_ended', async () => {
    const ok = await started(await makeJob(brandA))
    await stack.db.admin.query(`update app.job_attempt set state = 'succeeded' where id = $1`, [ok.attemptId])
    await expect(check(ok)).resolves.toBeUndefined()

    const failed = await started(await makeJob(brandA))
    await stack.db.admin.query(`update app.job_attempt set state = 'failed' where id = $1`, [
      failed.attemptId,
    ])
    await expect(check(failed)).rejects.toMatchObject({ status: 403, code: 'attempt_refused' })
    expect((await refusals()).some((r) => r.reason === 'attempt_ended' && r.jobId === failed.jobId)).toBe(
      true,
    )
  })

  it('serialises with starting a new attempt: a supersede waits for the caller, then the old attempt is refused', async () => {
    const jobId = await makeJob(brandA)
    const old = await started(jobId)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    let held: () => void = () => undefined
    const holding = new Promise<void>((resolve) => (held = resolve))

    const first = withBrand(stack.appPool, brandA, async (client) => {
      await requireCurrentAttempt(client, jobs, old)
      held()
      await gate
    })
    await holding

    let secondDone = false
    const second = startAttempt(jobs, jobId, 'w2').then((r) => {
      secondDone = true
      return r
    })
    // The competing start is blocked on a lock, not merely slow.
    let waiting = false
    for (let i = 0; i < 100 && !waiting; i++) {
      const { rows } = await stack.db.admin.query(
        `select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%app.job_input%'`,
      )
      waiting = rows.length > 0
      if (!waiting) await new Promise((r) => setTimeout(r, 50))
    }
    expect(waiting).toBe(true)
    expect(secondDone).toBe(false)

    release()
    await first
    await second
    await expect(check(old)).rejects.toMatchObject({ status: 403, code: 'attempt_refused' })
    expect((await refusals()).some((r) => r.reason === 'attempt_superseded' && r.jobId === jobId)).toBe(true)
  })
})
