import { sleep } from '@mkt/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerSummaryHandlers } from '../../core/src/agents/register.ts'
import { DbAudit } from '../../core/src/audit/db-audit.ts'
import type { JobsDeps } from '../../core/src/jobs/service.ts'
import { checkInjectOptions, injectLoad, parseInjectArgs, sendOffsets } from '../../core/src/load-inject.ts'
import { GOOD_RESULT } from '../../core/test/summary-support.ts'
import { createStack, type Stack } from '../../core/test/support.ts'
import { httpCoreClient } from '../src/core-client.ts'
import { defaultHandlers, startWorker } from '../src/main.ts'
import { standInModel } from '../src/standin.ts'

// Test 41 (spec 17) needs production-class load: the load-test injector (apps/core/src/load-inject.ts) makes
// summary runs whose first job is production class, through the product's own run and job creation.

describe('the load-test injector refuses', () => {
  const refusal = (args: string[]): string => {
    try {
      checkInjectOptions(parseInjectArgs(args))
    } catch (e) {
      return (e as Error).message
    }
    return ''
  }

  it('without --load-test', () => {
    expect(refusal(['--brands', 'load-test-a,load-test-b', '--jobs', '4'])).toMatch(/--load-test/)
  })

  it('any brand whose slug does not start with load-test-, naming the rule and not the brand', () => {
    for (const brands of [
      'aztek-global',
      'load-test-a,test-brand',
      'Load-test-a',
      'load-test-',
      'xload-test-a',
    ]) {
      const message = refusal(['--load-test', '--brands', brands, '--jobs', '4'])
      expect(message, brands).toMatch(/load-test-/)
      expect(message).not.toContain('aztek')
    }
  })

  it('a missing brand list, an unknown argument (without echoing it) and a bad count', () => {
    expect(refusal(['--load-test', '--jobs', '4'])).toMatch(/--brands/)
    const unknown = refusal(['--load-test', '--brands', 'load-test-a', '--password', 'hunter2'])
    expect(unknown).toMatch(/unknown argument/)
    expect(unknown).not.toContain('hunter2')
    expect(refusal(['--load-test', '--brands', 'load-test-a', '--jobs', '-1'])).toMatch(/--jobs/)
  })

  it('accepts the flag and load-test brands', () => {
    expect(
      refusal(['--load-test', '--brands', 'load-test-a,load-test-b', '--jobs', '300', '--minutes', '30']),
    ).toBe('')
  })
})

describe('the injection schedule (ruling R23)', () => {
  it('spreads the jobs evenly over the window less 60 s, so the last is sent at least 60 s before it closes', () => {
    const at = sendOffsets(300, 30)
    expect(at).toHaveLength(300)
    expect(at[0]).toBe(0)
    expect(at[299]).toBeLessThanOrEqual(1740_000)
    expect(at[299]).toBeGreaterThan(1730_000)
    const gaps = at.slice(1).map((t, i) => t - at[i]!)
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1)
    // The 2-minute dry run: 20 jobs in the first 60 s.
    expect(sendOffsets(20, 2).at(-1)).toBeLessThanOrEqual(60_000)
    // A window of a minute or less, or no window: all at once.
    expect(sendOffsets(3, 1)).toEqual([0, 0, 0])
    expect(sendOffsets(3, 0)).toEqual([0, 0, 0])
    expect(sendOffsets(0, 30)).toEqual([])
  })
})

describe('injected jobs', () => {
  let stack: Stack
  let jobs: JobsDeps
  let worker: { stop(): Promise<void> }

  beforeAll(async () => {
    stack = await createStack({ withQueue: true, realAudit: true })
    if (!stack.jobs) throw new Error('the stack has no queue')
    jobs = stack.jobs
    registerSummaryHandlers(jobs.results, jobs)
    const today = jobs.now().toISOString().slice(0, 10)
    await stack.db.admin.query(
      `insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, source)
       values ('claude-sonnet-5-5', $1::date - 30, 2000000, 10000000, 100000, 2500000, 'test')`,
      [today],
    )
    await stack.db.admin.query(`select app.record_fx_rate($1::date - 1, 83500000, 'test')`, [today])
    worker = await startWorker({
      core: httpCoreClient(stack.server.url, jobs.workerSecret),
      model: standInModel({ logFile: '/dev/null', replyFor: () => JSON.stringify(GOOD_RESULT) }),
      handlers: defaultHandlers(),
      queueUrl: stack.db.urlFor('queue'),
      workerId: 'load-inject',
      classes: ['production', 'interactive'],
      processesPerClass: 1,
      superviseIntervalSeconds: 1,
    })
  }, 120_000)

  afterAll(async () => {
    await worker?.stop()
    await stack?.close()
  })

  it('are production class, made through the run and job path the product uses, and claimed by the worker', async () => {
    const events: Record<string, unknown>[] = []
    const options = checkInjectOptions(
      parseInjectArgs([
        '--load-test',
        '--brands',
        'load-test-a,load-test-b',
        '--jobs',
        '4',
        '--minutes',
        '0',
      ]),
    )
    const done = await injectLoad(
      { pool: stack.db.admin, queue: jobs.queue, audit: new DbAudit(stack.db.admin), backlogLimit: 2000 },
      options,
      { emit: (e) => events.push(e) },
    )
    expect(done).toEqual({ sent: 4, failed: 0 })
    const sent = events.filter((e) => e.event === 'load_job')
    expect(sent.map((e) => e.brand)).toEqual(['load-test-a', 'load-test-b', 'load-test-a', 'load-test-b'])
    const runIds = sent.map((e) => e.runId as string)

    // The brands were created; each run is the summary agent's, started by the system; its first job is
    // production class with its control row and its queue row in the production queue.
    const q = async (sql: string, params: unknown[] = []) => (await stack.db.admin.query(sql, params)).rows
    expect((await q(`select count(*)::int as n from app.brand where slug like 'load-test-%'`))[0].n).toBe(2)
    const first = await q(
      `select r.agent, r.started_by_kind, i.class, i.expected_result_type, c.job_id is not null as controlled,
              q.name as queue
         from app.run r join app.job_input i on i.run_id = r.id and i.expected_result_type = 'summary.v1'
         left join app.job_control c on c.job_id = i.job_id left join pgboss.job q on q.id = i.job_id
        where r.id = any($1)`,
      [runIds],
    )
    expect(first).toHaveLength(4)
    for (const row of first) {
      expect(row).toMatchObject({
        agent: 'summary',
        started_by_kind: 'system',
        class: 'production',
        controlled: true,
        queue: 'job-production',
      })
    }
    const audit = await q(
      `select count(*)::int as n from audit.log where action = 'agent.run_started' and subject = any($1::text[])`,
      [runIds],
    )
    expect(audit[0].n).toBe(4)

    // The worker claims and finishes every one.
    const end = Date.now() + 60_000
    let states: string[] = []
    while (Date.now() < end) {
      states = (await q('select state from app.run where id = any($1)', [runIds])).map(
        (r) => r.state as string,
      )
      if (states.every((s) => s !== 'running')) break
      await sleep(500)
    }
    expect(states).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded'])
    const attempts = await q(
      `select count(*)::int as n from app.job_attempt a join app.job_input i on i.job_id = a.job_id
        where i.run_id = any($1) and i.class = 'production'`,
      [runIds],
    )
    expect(attempts[0].n).toBe(4)
  }, 90_000)

  it('refuses before touching the database when a brand is not a load-test brand', async () => {
    const before = (await stack.db.admin.query('select count(*)::int as n from app.run')).rows[0].n
    await expect(
      injectLoad(
        { pool: stack.db.admin, queue: jobs.queue, audit: new DbAudit(stack.db.admin), backlogLimit: 2000 },
        { loadTest: true, brands: ['test-brand'], jobs: 1, minutes: 0 },
        { emit: () => undefined },
      ),
    ).rejects.toThrow(/load-test-/)
    expect((await stack.db.admin.query('select count(*)::int as n from app.run')).rows[0].n).toBe(before)
  })
})
