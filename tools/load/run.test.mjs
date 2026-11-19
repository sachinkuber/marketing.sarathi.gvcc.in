import { describe, expect, it } from 'vitest'
import {
  compareContainers,
  cpuBusy,
  evaluate,
  jobsOf,
  loadUsers,
  n8nFigures,
  n8nSettings,
  parseArgs,
  parseCpu,
  parseMem,
  percentile,
  renderResults,
  slotWaits,
  summarizeDocker,
  swapPages,
} from './run.mjs'

describe('the load-test arguments', () => {
  it('defaults to the spec 17 workload', () => {
    expect(parseArgs(['--origin', 'https://app.example.test'])).toMatchObject({
      origin: 'https://app.example.test',
      connect: null,
      minutes: 30,
      jobs: 300,
      users: 10,
      probeEvery: 10,
      project: 'mkt',
    })
  })

  it('takes the scaled-down dry run, in both spellings', () => {
    const o = parseArgs([
      '--origin=https://app.example.test',
      '--connect',
      'http://127.0.0.1:4100',
      '--minutes',
      '2',
      '--jobs=20',
      '--users',
      '3',
      '--project',
      'mkt-m7test',
      '--results',
      '/tmp/out.md',
    ])
    expect(o).toMatchObject({
      connect: 'http://127.0.0.1:4100',
      minutes: 2,
      jobs: 20,
      users: 3,
      project: 'mkt-m7test',
    })
  })

  it('refuses an unknown argument without echoing it (a password pasted by mistake)', () => {
    let message = ''
    try {
      parseArgs(['--origin', 'https://app.example.test', '--password', 'hunter2-secret'])
    } catch (e) {
      message = e.message
    }
    expect(message).toMatch(/unknown argument/)
    expect(message).not.toContain('hunter2')
  })

  it('refuses a missing origin, a path or credentials in it, and out-of-range numbers', () => {
    expect(() => parseArgs([])).toThrow('--origin is missing')
    expect(() => parseArgs(['--origin', 'https://app.example.test/x'])).toThrow('bare origin')
    expect(() => parseArgs(['--origin', 'https://u:p@app.example.test'])).toThrow('without credentials')
    expect(() => parseArgs(['--origin', 'https://a.test', '--minutes', '0'])).toThrow('--minutes')
    expect(() => parseArgs(['--origin', 'https://a.test', '--jobs', '1.5'])).toThrow('--jobs')
    expect(() => parseArgs(['--origin', 'https://a.test', '--results', 'out.txt'])).toThrow('.md')
  })
})

describe('the test users', () => {
  const user = (n, brand) => ({
    email: `load${n}@example.test`,
    password: `password-${n}`,
    totpSecret: 'JBSWY3DPEHPK3PXP',
    brand,
  })
  const file = (mode, users, uid = 1000) => ({
    stat: () => ({ isFile: () => true, mode: 0o100000 | mode, uid }),
    read: () => JSON.stringify({ users }),
    uid: 1000,
  })

  it('reads two users from a 0600 file', () => {
    const users = loadUsers({ LOAD_USERS_FILE: '/x' }, file(0o600, [user(1, 'a'), user(2, 'b')]))
    expect(users.map((u) => u.brand)).toEqual(['a', 'b'])
  })

  it('refuses a file others can read, or one owned by someone else', () => {
    expect(() => loadUsers({ LOAD_USERS_FILE: '/x' }, file(0o644, [user(1, 'a'), user(2, 'b')]))).toThrow(
      '0600',
    )
    expect(() => loadUsers({ LOAD_USERS_FILE: '/x' }, file(0o600, [user(1, 'a'), user(2, 'b')], 0))).toThrow(
      'belong',
    )
  })

  it('reads them from LOAD_USER_1_* and LOAD_USER_2_* without the file', () => {
    const env = {}
    for (const n of [1, 2]) {
      const u = user(n, n === 1 ? 'aztek-global' : 'test-brand')
      Object.assign(env, {
        [`LOAD_USER_${n}_EMAIL`]: u.email,
        [`LOAD_USER_${n}_PASSWORD`]: u.password,
        [`LOAD_USER_${n}_TOTP`]: u.totpSecret,
        [`LOAD_USER_${n}_BRAND`]: u.brand,
      })
    }
    expect(loadUsers(env).map((u) => u.brand)).toEqual(['aztek-global', 'test-brand'])
  })

  it('needs exactly two users for two brands, each with an authenticator secret, and names no value', () => {
    const opts = (users) => file(0o600, users)
    expect(() => loadUsers({ LOAD_USERS_FILE: '/x' }, opts([user(1, 'a')]))).toThrow('two test users')
    expect(() => loadUsers({ LOAD_USERS_FILE: '/x' }, opts([user(1, 'a'), user(2, 'a')]))).toThrow(
      'different brands',
    )
    let message = ''
    try {
      loadUsers({ LOAD_USERS_FILE: '/x' }, opts([user(1, 'a'), { ...user(2, 'b'), totpSecret: undefined }]))
    } catch (e) {
      message = e.message
    }
    expect(message).toMatch(/test user 2/)
    expect(message).not.toContain('password-2')
    expect(message).not.toContain('load2@')
    expect(() => loadUsers({})).toThrow('two test users')
  })

  it('treats n8n as optional', () => {
    expect(n8nSettings({})).toBeNull()
    expect(n8nSettings({ N8N_API_URL: 'https://n8n.example.test' })).toBeNull()
    expect(n8nSettings({ N8N_API_URL: 'https://n8n.example.test', N8N_API_KEY: 'k' })).toEqual({
      url: 'https://n8n.example.test',
      key: 'k',
      canaryId: null,
    })
  })
})

describe('the figures', () => {
  it('percentile is the nearest rank', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(values, 0.95)).toBe(95)
    expect(percentile(values, 0.99)).toBe(99)
    expect(percentile([5], 0.95)).toBe(5)
    expect(percentile([], 0.5)).toBeNull()
  })

  it('reads docker stats memory and processor figures', () => {
    expect(parseMem('512MiB / 1GiB')).toBe(512 * 1024 ** 2)
    expect(parseMem('1.5GiB / 4GiB')).toBe(1.5 * 1024 ** 3)
    expect(parseMem('900kB / 1GB')).toBe(900e3)
    expect(parseMem('--')).toBeNull()
    expect(parseCpu('37.50%')).toBe(0.375)
    expect(parseCpu('--')).toBeNull()
  })

  it('totals the containers per sample and keeps the peak', () => {
    const s = summarizeDocker([
      [
        { name: 'core', cpu: 0.4, mem: 1e9 },
        { name: 'worker', cpu: 0.3, mem: 5e8 },
      ],
      [
        { name: 'core', cpu: 1.0, mem: 1e9 },
        { name: 'worker', cpu: 0.2, mem: 1e9 },
      ],
      [],
    ])
    expect(s.samples).toBe(2)
    expect(s.maxCpu).toBeCloseTo(1.2)
    expect(s.meanCpu).toBeCloseTo(0.95)
    expect(s.maxMem).toBe(2e9)
    expect(s.containers).toEqual(['core', 'worker'])
    expect(summarizeDocker([])).toBeNull()
  })

  it('reads the server processor share from /proc/stat and swapping from /proc/vmstat', () => {
    const before = 'cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 1 1 1\n'
    const after = 'cpu  200 0 200 1200 200 0 0 0 0 0\n'
    // busy 200 of 800
    expect(cpuBusy(before, after)).toBeCloseTo(0.25)
    expect(cpuBusy('nothing', after)).toBeNull()
    expect(swapPages('pswpin 10\npswpout 5\n', 'pswpin 10\npswpout 5\n')).toBe(0)
    expect(swapPages('pswpin 10\npswpout 5\n', 'pswpin 12\npswpout 8\n')).toBe(5)
    expect(swapPages('', 'pswpin 1\n')).toBeNull()
  })

  it('takes each job, its claim and its end from a run detail', () => {
    const jobs = jobsOf(
      {
        run: { id: 'r1' },
        jobs: [
          {
            expectedResultType: 'summary.v1',
            createdAt: '2026-01-01T00:00:00.000Z',
            attempts: [{ startedAt: '2026-01-01T00:00:00.300Z', endedAt: '2026-01-01T00:00:02.400Z' }],
          },
          { expectedResultType: 'check.v1', createdAt: '2026-01-01T00:00:02.400Z', attempts: [] },
        ],
      },
      'b1',
      'probe',
    )
    expect(jobs[0]).toMatchObject({
      brand: 'b1',
      kind: 'probe',
      runId: 'r1',
      summary: true,
      createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    })
    expect(jobs[0].claimedAt - jobs[0].createdAt).toBe(300)
    expect(jobs[1]).toMatchObject({ summary: false, claimedAt: null, endedAt: null })
  })

  it('counts a waiting job from the moment a slot of its brand became free', () => {
    const waits = slotWaits([
      { brand: 'a', createdAt: 0, claimedAt: 100, endedAt: 2000 },
      // Waited 2.9 s in all, but only 900 ms after the first job's slot became free.
      { brand: 'a', createdAt: 0, claimedAt: 2900, endedAt: 5000 },
      // Another brand's end does not count.
      { brand: 'b', createdAt: 1000, claimedAt: 7000, endedAt: 8000 },
      { brand: 'b', createdAt: 0, claimedAt: null, endedAt: null },
    ])
    expect(waits).toEqual([100, 900, 6000, Infinity])
  })

  it('compares the canary with the hour before and counts failed executions in the window', () => {
    const start = Date.parse('2026-01-01T10:00:00Z')
    const end = start + 30 * 60_000
    const exec = (minute, ms, status = 'success', workflowId = 'c1') => ({
      workflowId,
      status,
      startedAt: new Date(start + minute * 60_000).toISOString(),
      stoppedAt: new Date(start + minute * 60_000 + ms).toISOString(),
    })
    const f = n8nFigures(
      [
        exec(-90, 9999),
        exec(-30, 100),
        exec(-10, 200),
        exec(5, 150),
        exec(6, 210),
        exec(7, 50, 'error', 'other'),
        exec(45, 5000),
      ],
      'c1',
      { baselineStart: start - 3_600_000, start, end },
    )
    expect(f).toEqual({
      baselineRuns: 2,
      baselineMeanMs: 150,
      windowRuns: 2,
      windowMeanMs: 180,
      windowMaxMs: 210,
      failed: 1,
    })
  })

  it('reports a restart, a replaced container or an out-of-memory kill, and ignores the one-shot services', () => {
    const c = (service, id, restarts = 0, status = 'running', oom = false) => ({
      service,
      id,
      restarts,
      status,
      oom,
    })
    const before = [c('core', '1'), c('worker', '2'), c('ops', '9', 0, 'exited')]
    expect(compareContainers(before, [c('core', '1'), c('worker', '2'), c('ops', '9', 0, 'exited')])).toEqual(
      {
        ok: true,
        text: 'none (core, worker)',
      },
    )
    const bad = compareContainers(
      before,
      [c('core', '1', 1), c('worker', '3', 0, 'running', true)],
      [{ service: 'worker', action: 'oom' }],
    )
    expect(bad.ok).toBe(false)
    expect(bad.text).toContain('core restarted 1 times')
    expect(bad.text).toContain('worker replaced')
    expect(bad.text).toContain('worker killed for lack of memory')
    expect(bad.text).toContain('worker: oom')
    expect(compareContainers([], []).ok).toBe(false)
  })
})

describe('the results table', () => {
  const passing = {
    options: { minutes: 30, jobs: 300, users: 10, probeEvery: 10, grace: 120 },
    brands: 2,
    submitted: { jobs: 300, probes: 180 },
    windowMs: 30 * 60_000,
    modelMedianMs: 2004,
    docker: {
      samples: 360,
      maxCpu: 1.1,
      meanCpu: 0.6,
      maxMem: 2.5 * 1024 ** 3,
      containers: ['a', 'b', 'c', 'd'],
    },
    containers: { ok: true, text: 'none' },
    serverCpu: 0.42,
    swapPages: 0,
    api: { count: 18000, failed: 0, p95: 120, p99: 400, max: 900 },
    probes: { count: 180, withinShare: 0.99, p95: 300, max: 1200 },
    production: {
      count: 300,
      maxSlotWait: 800,
      p95Wait: 500,
      maxWait: 900,
      finishedInWindow: 300,
      finishedByGrace: 300,
    },
    dead: 0,
    n8n: {
      baselineRuns: 60,
      baselineMeanMs: 100,
      windowRuns: 30,
      windowMeanMs: 110,
      windowMaxMs: 160,
      failed: 0,
    },
  }

  it('has one row per criterion of spec 17 and passes a run inside every limit', () => {
    const rows = evaluate(passing)
    expect(rows.map((r) => r.aspect)).toEqual([
      'Workload',
      'Workload',
      'Duration',
      'Product limits',
      'Product limits',
      'Product limits',
      'Server',
      'Server',
      'Core API response',
      'Core API response',
      'Queue, interactive',
      'Queue, production',
      'Queue, production',
      'Queue, production',
      'Impact on n8n',
      'Impact on n8n',
    ])
    expect(rows.every((r) => r.result === 'PASS')).toBe(true)
    const md = renderResults(
      {
        date: '2026-12-01',
        start: 's',
        end: 'e',
        origin: 'https://a.test',
        project: 'mkt',
        args: '--origin https://a.test',
        fullWorkload: true,
      },
      rows,
    )
    expect(md).toContain('| Aspect | Criterion | Measured | Limit | Result |')
    expect(md.split('\n').filter((l) => /\| (PASS|FAIL|not measured) \|$/.test(l))).toHaveLength(16)
    expect(md).toContain('Overall: PASS.')
    expect(md).not.toContain('it is not test 41')
  })

  it('marks the n8n rows "not measured" without the n8n API, and the run incomplete', () => {
    const rows = evaluate({ ...passing, n8n: null })
    const n8n = rows.filter((r) => r.aspect === 'Impact on n8n')
    expect(n8n.map((r) => r.result)).toEqual(['not measured', 'not measured'])
    expect(n8n[0].measured).toMatch(/not configured/)
    const md = renderResults(
      { date: 'd', start: 's', end: 'e', origin: 'o', project: 'p', args: '', fullWorkload: true },
      rows,
    )
    expect(md).toContain('Overall: incomplete')
  })

  it('fails each limit that is passed, and flags a scaled-down run as not test 41', () => {
    const rows = evaluate({
      ...passing,
      options: { ...passing.options, minutes: 2, jobs: 20, users: 3 },
      submitted: { jobs: 20, probes: 12 },
      windowMs: 120_000,
      docker: { ...passing.docker, maxCpu: 2.3, maxMem: 4.5 * 1024 ** 3 },
      serverCpu: 0.85,
      swapPages: 12,
      api: { count: 100, failed: 1, p95: 600, p99: 1600, max: 2000 },
      probes: { count: 12, withinShare: 0.9, p95: 1500, max: 2000 },
      production: {
        count: 20,
        maxSlotWait: 6000,
        p95Wait: 6000,
        maxWait: 7000,
        finishedInWindow: 19,
        finishedByGrace: 20,
      },
      dead: 1,
      n8n: { ...passing.n8n, windowMeanMs: 130, failed: 2 },
    })
    expect(rows.filter((r) => r.result === 'PASS').map((r) => r.criterion)).toEqual([
      'The model is a stand-in that answers in 2 seconds',
      'No container restarted or stopped for lack of memory',
    ])
    const md = renderResults(
      { date: 'd', start: 's', end: 'e', origin: 'o', project: 'p', args: '', fullWorkload: false },
      rows,
    )
    expect(md).toContain('it is not test 41')
    expect(md).toContain('Overall: FAIL.')
  })
})
