// Test 41 driver (spec 17, "Test 41: load and impact on n8n"; plan M7 decision 10 and Task 11). Needs only
// Node 24 and, for the container figures, the Docker CLI; no dependency.
//
//   node tools/load/run.mjs --origin <url> [--connect <url>] [--minutes 30] [--jobs 300] [--users 10]
//                           [--probe-every 10] [--project mkt] [--grace 120] [--slot-cap 3] [--results <file.md>]
//
//   --origin        The product's public origin (its PUBLIC_ORIGIN). Sent as the Origin header, which the core
//                   requires on every write, and where requests go unless --connect is given.
//   --connect       Send the requests here instead, e.g. http://127.0.0.1:4100 on the host itself.
//   --minutes       Length of the test window (spec: 30).
//   --jobs          Production-class summary jobs injected evenly over the window less its last 60 s (ruling
//                   R23), alternating the two brands
//                   (spec: 300), by the load-test injector (apps/core/src/load-inject.ts) run in this project's
//                   core container with `docker exec`. The probes and the users go over HTTP.
//   --users         Simulated dashboard users, each making one GET a second (spec: 10).
//   --probe-every   Seconds between interactive probe jobs (spec: 10).
//   --project       Compose project whose containers `docker stats` samples (label com.docker.compose.project).
//   --grace         Seconds after the window to wait for the last runs to end before reading the figures.
//   --slot-cap      The production cap of a brand (spec 9.2: 3 with one worker process for the class).
//   --results       Also write the results table to this Markdown file (e.g. docs/acceptance/<date>-test-41.md).
//                   The origin and --connect are written as "(set)".
//
// Credentials never come from the command line and are never printed (not even the addresses):
//   LOAD_USERS_FILE  A JSON file, mode 0600, {"users": [{"email", "password", "totpSecret", "brand"}, {...}]}:
//                    two users, one per brand ("brand" is the brand's slug or id). Or, without the file:
//   LOAD_USER_1_EMAIL, LOAD_USER_1_PASSWORD, LOAD_USER_1_TOTP, LOAD_USER_1_BRAND, and the same with _2_.
// ADMIN_DATABASE_URL  The database superuser's address as the core container reaches it (postgres.env), handed to
//                     the injector by name (`docker exec -e ADMIN_DATABASE_URL`), never on a command line.
// The two brands must be load-test brands (slug `load-test-...`): the injector refuses any other, and creates
// them when missing, before the users sign in.
// Starting a summary run is the platform owner's alone (see_other_brands, plan M5 decision 5), and every
// platform owner has a second factor (SEC-1), so each user needs its authenticator secret ("totpSecret").
//
// n8n is optional; without it the two n8n criteria are reported "not measured":
//   N8N_API_URL                The n8n origin (its public API is under /api/v1).
//   N8N_API_KEY                An n8n API key (read-only use: executions and workflows are listed, never changed).
//   N8N_CANARY_WORKFLOW_ID     The id of `Marketing — canary`; looked up by that name when unset.
//
// The worker must run the stand-in model with a 2 s answer: MODEL_BACKEND=standin, NODE_ENV=test,
// STANDIN_DELAY_MS=2000 (the worker refuses the stand-in outside NODE_ENV=test). Set it back afterwards.
//
// What it measures, and how, is in tools/load/README.md. It prints figures, statuses and error names only.
import { execFile, spawn } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { totp } from '../../packages/test-support/src/totp.ts'

// --- the criteria of spec 17, test 41 ------------------------------------------------------------------------

export const SPEC = {
  minutes: 30,
  jobs: 300,
  users: 10,
  probeEvery: 10,
  brands: 2,
  standinMs: 2000,
  productCpuCores: 2,
  productMemBytes: 4 * 1024 ** 3,
  serverCpuPercent: 80,
  apiP95Ms: 500,
  apiP99Ms: 1500,
  probeClaimMs: 1000,
  probeClaimShare: 0.95,
  slotClaimMs: 5000,
  canaryFactor: 1.2,
}

const REQUEST_TIMEOUT_MS = 10_000
const DOCKER_EVERY_MS = 5000
const CANARY_NAME = 'Marketing — canary'
const BRIEF = (kind, n) => `Load test ${kind} ${n}: the monsoon range, two lines, friendly tone.`

// --- arguments -----------------------------------------------------------------------------------------------

const USAGE =
  'usage: node tools/load/run.mjs --origin <url> [--connect <url>] [--minutes 30] [--jobs 300] [--users 10] ' +
  '[--probe-every 10] [--project mkt] [--grace 120] [--results <file.md>]'

function bareOrigin(value, what) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${what} is not a URL`)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${what} must be an http(s) origin without credentials`)
  }
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(`${what} must be a bare origin`)
  return url.origin
}

function whole(value, what, min, max) {
  if (!/^\d+$/.test(value ?? '') || Number(value) < min || Number(value) > max) {
    throw new Error(`${what} must be a whole number from ${min} to ${max}`)
  }
  return Number(value)
}

export function parseArgs(argv) {
  const options = {
    origin: null,
    connect: null,
    minutes: SPEC.minutes,
    jobs: SPEC.jobs,
    users: SPEC.users,
    probeEvery: SPEC.probeEvery,
    project: 'mkt',
    grace: 120,
    slotCap: BRAND_CAPS.production,
    results: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const name = eq > 0 ? arg.slice(0, eq) : arg
    const value = () => (eq > 0 ? arg.slice(eq + 1) : argv[(i += 1)])
    switch (name) {
      case '--origin':
        options.origin = bareOrigin(value(), '--origin')
        break
      case '--connect':
        options.connect = bareOrigin(value(), '--connect')
        break
      case '--minutes':
        options.minutes = whole(value(), '--minutes', 1, 240)
        break
      case '--jobs':
        options.jobs = whole(value(), '--jobs', 1, 10_000)
        break
      case '--users':
        options.users = whole(value(), '--users', 0, 200)
        break
      case '--probe-every':
        options.probeEvery = whole(value(), '--probe-every', 1, 3600)
        break
      case '--project': {
        const project = value()
        if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project ?? ''))
          throw new Error('--project is not a project name')
        options.project = project
        break
      }
      case '--slot-cap':
        options.slotCap = whole(value(), '--slot-cap', 1, 100)
        break
      case '--grace':
        options.grace = whole(value(), '--grace', 0, 3600)
        break
      case '--results': {
        const file = value()
        if (!file || !file.endsWith('.md')) throw new Error('--results must name a .md file')
        options.results = file
        break
      }
      default:
        // Never echo the argument: a password pasted here by mistake must not reach the terminal log.
        throw new Error('unknown argument (credentials come from LOAD_USERS_FILE or LOAD_USER_* only)')
    }
  }
  if (!options.origin) throw new Error('--origin is missing')
  return options
}

// The arguments as written into the results: the addresses are not (the connect address may be a private one).
export function maskArgs(argv) {
  const out = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    if (name === '--origin' || name === '--connect') {
      out.push(name, '(set)')
      if (!arg.includes('=')) i += 1
    } else out.push(arg)
  }
  return out.join(' ')
}

// --- credentials ---------------------------------------------------------------------------------------------

function checkUser(user, n) {
  const ok =
    user &&
    typeof user.email === 'string' &&
    user.email.includes('@') &&
    typeof user.password === 'string' &&
    user.password.length > 0 &&
    typeof user.totpSecret === 'string' &&
    /^[A-Z2-7]+=*$/i.test(user.totpSecret) &&
    typeof user.brand === 'string' &&
    user.brand.length > 0
  if (!ok) throw new Error(`test user ${n}: email, password, totpSecret (base32) and brand are all required`)
  return {
    email: user.email,
    password: user.password,
    totpSecret: user.totpSecret,
    brand: user.brand,
    lastStep: null,
  }
}

// Two users, one per brand. `stat` and `read` are passed in so the checks can be tested without a real file.
export function loadUsers(
  env,
  { stat = statSync, read = (file) => readFileSync(file, 'utf8'), uid = process.getuid?.() } = {},
) {
  let raw
  if (env.LOAD_USERS_FILE) {
    const info = stat(env.LOAD_USERS_FILE)
    if (!info.isFile()) throw new Error('LOAD_USERS_FILE is not a file')
    if ((info.mode & 0o077) !== 0)
      throw new Error('LOAD_USERS_FILE must be mode 0600 (no group or other access)')
    if (uid !== undefined && info.uid !== uid)
      throw new Error('LOAD_USERS_FILE must belong to the user running this')
    let parsed
    try {
      parsed = JSON.parse(read(env.LOAD_USERS_FILE))
    } catch {
      throw new Error('LOAD_USERS_FILE is not valid JSON')
    }
    raw = parsed?.users
  } else {
    raw = [1, 2]
      .map((n) =>
        env[`LOAD_USER_${n}_EMAIL`] === undefined
          ? undefined
          : {
              email: env[`LOAD_USER_${n}_EMAIL`],
              password: env[`LOAD_USER_${n}_PASSWORD`],
              totpSecret: env[`LOAD_USER_${n}_TOTP`],
              brand: env[`LOAD_USER_${n}_BRAND`],
            },
      )
      .filter(Boolean)
  }
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new Error('two test users are needed (LOAD_USERS_FILE or LOAD_USER_1_* and LOAD_USER_2_*)')
  }
  const users = raw.map((user, i) => checkUser(user, i + 1))
  if (!users.every((u) => /^load-test-[a-z0-9][a-z0-9-]*$/.test(u.brand))) {
    throw new Error("each test user's brand must be a load-test brand slug (load-test-...)")
  }
  if (users[0].brand === users[1].brand)
    throw new Error('the two test users must be for two different brands')
  return users
}

export function n8nSettings(env) {
  if (!env.N8N_API_URL || !env.N8N_API_KEY) return null
  return {
    url: bareOrigin(env.N8N_API_URL, 'N8N_API_URL'),
    key: env.N8N_API_KEY,
    canaryId: env.N8N_CANARY_WORKFLOW_ID || null,
  }
}

// --- figures -------------------------------------------------------------------------------------------------

// Nearest rank: the smallest value with at least p of the values at or below it.
export function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)

const UNITS = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
}

// `docker stats` memory: "123.4MiB / 1GiB" -> the used bytes.
export function parseMem(text) {
  const match = /^\s*([\d.]+)\s*([a-z]+)/i.exec(String(text))
  const unit = match && UNITS[match[2].toLowerCase()]
  if (!unit) return null
  return Number(match[1]) * unit
}

// `docker stats` processor: "12.50%" of one core -> cores.
export function parseCpu(text) {
  const match = /^\s*([\d.]+)%/.exec(String(text))
  return match ? Number(match[1]) / 100 : null
}

// Each sample: [{ name, cpu, mem }] for the project's containers at one moment. Totals per sample.
export function summarizeDocker(samples) {
  const totals = samples
    .filter((s) => s.length > 0)
    .map((s) => ({
      cpu: s.reduce((a, c) => a + (c.cpu ?? 0), 0),
      mem: s.reduce((a, c) => a + (c.mem ?? 0), 0),
    }))
  if (totals.length === 0) return null
  return {
    samples: totals.length,
    maxCpu: Math.max(...totals.map((t) => t.cpu)),
    meanCpu: mean(totals.map((t) => t.cpu)),
    maxMem: Math.max(...totals.map((t) => t.mem)),
    containers: [...new Set(samples.flat().map((c) => c.name))].sort(),
  }
}

// /proc/stat "cpu" lines at the start and the end -> share of time busy (not idle and not waiting on disk).
export function cpuBusy(before, after) {
  const fields = (text) => {
    const line = String(text)
      .split('\n')
      .find((l) => /^cpu\s/.test(l))
    return line ? line.trim().split(/\s+/).slice(1).map(Number) : null
  }
  const a = fields(before)
  const b = fields(after)
  if (!a || !b) return null
  const d = b.map((v, i) => v - (a[i] ?? 0))
  // user nice system idle iowait irq softirq steal (guest is already counted in user).
  const idle = (d[3] ?? 0) + (d[4] ?? 0)
  const total = d.slice(0, 8).reduce((x, y) => x + y, 0)
  return total > 0 ? (total - idle) / total : null
}

// /proc/vmstat at the start and the end -> pages swapped in and out during the window.
export function swapPages(before, after) {
  const read = (text) => {
    const out = {}
    for (const line of String(text).split('\n')) {
      const [k, v] = line.trim().split(/\s+/)
      if (k === 'pswpin' || k === 'pswpout') out[k] = Number(v)
    }
    return 'pswpin' in out && 'pswpout' in out ? out : null
  }
  const a = read(before)
  const b = read(after)
  if (!a || !b) return null
  return b.pswpin - a.pswpin + (b.pswpout - a.pswpout)
}

// The jobs of the runs this test started, from the run detail: the summary job (the one the test sent) and the
// check job each summary leads to. Times in ms since the epoch.
export function jobsOf(detail, brand, kind) {
  return (detail.jobs ?? []).map((job) => {
    const attempts = job.attempts ?? []
    return {
      brand,
      kind,
      class: job.jobClass,
      runId: detail.run?.id,
      summary: job.expectedResultType === 'summary.v1',
      createdAt: Date.parse(job.createdAt),
      claimedAt: attempts.length ? Date.parse(attempts[0].startedAt) : null,
      // Still running (an attempt with no end) holds its slot to the end of the reading.
      endedAt: attempts.length
        ? attempts.some((a) => !a.endedAt)
          ? Infinity
          : Math.max(...attempts.map((a) => Date.parse(a.endedAt)))
        : null,
    }
  })
}

// The per-brand caps of spec 9.2 (packages/queue CLASS_SETTINGS brandCap), for one worker process per class.
export const BRAND_CAPS = { interactive: 2, publishing: 2, production: 3, bulk: 1 }

// "Claimed within 5 s of a slot being free for its brand." The brand's occupancy of the job's class is rebuilt
// from every job read (claim to last end). A job's wait runs from the later of its creation and the start of
// the last stretch before its claim in which fewer than the cap of its brand and class were running. If the
// slots were full right up to the claim, the wait is 0. Never claimed: an infinite wait.
export function slotWaits(jobs, caps = BRAND_CAPS) {
  return jobs.map((j) => {
    if (j.claimedAt == null) return Infinity
    const cap = caps[j.class] ?? Infinity
    const others = jobs.filter(
      (k) => k !== j && k.brand === j.brand && k.class === j.class && k.claimedAt != null,
    )
    const end = (k) => k.endedAt ?? Infinity
    const running = (t) => others.filter((k) => k.claimedAt <= t && end(k) > t).length
    const points = [
      ...new Set(
        [j.createdAt, ...others.flatMap((k) => [k.claimedAt, end(k)])].filter(
          (t) => t >= j.createdAt && t < j.claimedAt,
        ),
      ),
    ].sort((x, y) => x - y)
    // Walk the stretches between the change points back from the claim while a slot was free.
    let freeFrom = j.claimedAt
    for (let i = points.length - 1; i >= 0; i -= 1) {
      if (running(points[i]) >= cap) break
      freeFrom = points[i]
    }
    return j.claimedAt - freeFrom
  })
}

// n8n executions (newest first, the public API's shape) -> the canary's mean before and during the window, and
// every failed execution in the window.
export function n8nFigures(executions, canaryId, { baselineStart, start, end }) {
  const at = (e) => Date.parse(e.startedAt)
  const took = (e) => Date.parse(e.stoppedAt) - Date.parse(e.startedAt)
  const canary = executions.filter(
    (e) => String(e.workflowId) === String(canaryId) && e.status === 'success' && e.stoppedAt,
  )
  const before = canary.filter((e) => at(e) >= baselineStart && at(e) < start).map(took)
  const during = canary.filter((e) => at(e) >= start && at(e) < end).map(took)
  const failed = executions.filter(
    (e) => at(e) >= start && at(e) < end && ['error', 'crashed', 'failed'].includes(e.status),
  )
  return {
    baselineRuns: before.length,
    baselineMeanMs: mean(before),
    windowRuns: during.length,
    windowMeanMs: mean(during),
    windowMaxMs: during.length ? Math.max(...during) : null,
    failed: failed.length,
  }
}

// --- verdicts and the results table --------------------------------------------------------------------------

const ms = (v) => (v == null ? '-' : `${Math.round(v)} ms`)
const gib = (v) => `${(v / 1024 ** 3).toFixed(2)} GiB`
const pct = (v) => `${(v * 100).toFixed(1)} %`

const PASS = 'PASS'
const FAIL = 'FAIL'
const NOT = 'not measured'
const verdict = (ok) => (ok ? PASS : FAIL)

// One row per criterion of spec 17, test 41. `m` holds what was measured; a missing figure is "not measured"
// with the reason.
export function evaluate(m) {
  const rows = []
  const row = (aspect, criterion, measured, limit, result) =>
    rows.push({ aspect, criterion, measured, limit, result })

  const fullWorkload =
    m.options.jobs === SPEC.jobs && m.options.users === SPEC.users && m.options.probeEvery === SPEC.probeEvery
  row(
    'Workload',
    'Two brands, 300 production-class jobs evenly, 10 users at 1 request a second, a probe every 10 s',
    `${m.brands} brands, ${m.submitted.jobs} of ${m.options.jobs} jobs sent, ${m.options.users} users, ` +
      `a probe every ${m.options.probeEvery} s (${m.submitted.probes} sent)`,
    '2 brands, 300 jobs, 10 users, 10 s',
    verdict(fullWorkload && m.brands === SPEC.brands && m.submitted.jobs === SPEC.jobs),
  )
  row(
    'Workload',
    'The model is a stand-in that answers in 2 seconds',
    m.modelMedianMs == null ? 'no model call seen' : `median model call ${ms(m.modelMedianMs)}`,
    '2000 ms (STANDIN_DELAY_MS=2000)',
    m.modelMedianMs == null ? NOT : verdict(m.modelMedianMs >= 1900 && m.modelMedianMs < 3000),
  )
  row(
    'Duration',
    '30 minutes',
    `${(m.windowMs / 60_000).toFixed(1)} min`,
    '30 min',
    verdict(m.options.minutes === SPEC.minutes && m.windowMs >= SPEC.minutes * 60_000 - 1000),
  )

  if (!m.docker) {
    for (const criterion of [
      'Processor: all product containers within 2 cores',
      'Memory: all product containers within 4 GB',
    ])
      row('Product limits', criterion, m.dockerWhy ?? 'docker stats unavailable', '-', NOT)
  } else {
    row(
      'Product limits',
      'Processor: all product containers within 2 cores',
      `peak ${m.docker.maxCpu.toFixed(2)} cores, mean ${m.docker.meanCpu.toFixed(2)} (${m.docker.samples} samples of ${m.docker.containers.length} containers)`,
      '2.00 cores',
      verdict(m.docker.maxCpu <= SPEC.productCpuCores),
    )
    row(
      'Product limits',
      'Memory: all product containers within 4 GB',
      `peak ${gib(m.docker.maxMem)}`,
      '4.00 GiB',
      verdict(m.docker.maxMem <= SPEC.productMemBytes),
    )
  }
  row(
    'Product limits',
    'No container restarted or stopped for lack of memory',
    m.containers == null ? (m.dockerWhy ?? 'docker unavailable') : m.containers.text,
    'none',
    m.containers == null ? NOT : verdict(m.containers.ok),
  )

  row(
    'Server',
    'Average processor use below 80 percent',
    m.serverCpu == null ? '/proc/stat unreadable' : pct(m.serverCpu),
    '< 80 %',
    m.serverCpu == null ? NOT : verdict(m.serverCpu * 100 < SPEC.serverCpuPercent),
  )
  row(
    'Server',
    'No swapping',
    m.swapPages == null ? '/proc/vmstat unreadable' : `${m.swapPages} pages swapped in or out`,
    '0 pages',
    m.swapPages == null ? NOT : verdict(m.swapPages === 0),
  )

  const api = m.api
  const errors = api.failed ? `, ${api.failed} failed` : ''
  row(
    'Core API response',
    '95 percent of requests under 500 ms',
    api.count ? `p95 ${ms(api.p95)} over ${api.count} requests${errors}` : 'no request',
    '< 500 ms',
    api.count ? verdict(api.p95 < SPEC.apiP95Ms && api.failed === 0) : NOT,
  )
  row(
    'Core API response',
    '99 percent of requests under 1.5 s',
    api.count ? `p99 ${ms(api.p99)}, max ${ms(api.max)}${errors}` : 'no request',
    '< 1500 ms',
    api.count ? verdict(api.p99 < SPEC.apiP99Ms && api.failed === 0) : NOT,
  )

  const probes = m.probes
  row(
    'Queue, interactive',
    '95 percent of probes claimed within 1 second of being sent',
    probes.count
      ? `${pct(probes.withinShare)} of ${probes.count} within 1 s (p95 ${ms(probes.p95)}, max ${ms(probes.max)})`
      : 'no probe read',
    '>= 95.0 %',
    probes.count
      ? verdict(probes.withinShare >= SPEC.probeClaimShare && probes.count === m.submitted.probes)
      : NOT,
  )

  const queue = m.production
  row(
    'Queue, production',
    'Every production job claimed within 5 s of a slot being free for its brand',
    queue.count
      ? `max ${ms(queue.maxSlotWait)} after a slot was free, over ${queue.count} production-class jobs (cap ${m.options.slotCap} a brand; plain wait from creation: p95 ${ms(queue.p95Wait)}, max ${ms(queue.maxWait)})`
      : 'no production job read',
    '<= 5000 ms, every job',
    queue.count ? verdict(queue.maxSlotWait <= SPEC.slotClaimMs) : NOT,
  )
  row(
    'Queue, production',
    'All production jobs finish inside the test',
    `${queue.finishedInWindow} of ${m.options.jobs} finished inside the window (${queue.finishedByGrace} by its end + ${m.options.grace} s)`,
    `${m.options.jobs} of ${m.options.jobs}`,
    verdict(queue.finishedInWindow === m.options.jobs),
  )
  row(
    'Queue, production',
    'No job in the dead-letter list',
    m.dead == null ? 'dead-letter list unreadable' : `${m.dead} dead`,
    '0',
    m.dead == null ? NOT : verdict(m.dead === 0),
  )

  const n8n = m.n8n
  if (!n8n || n8n.error) {
    const why = n8n?.error ?? 'n8n API not configured (N8N_API_URL, N8N_API_KEY)'
    row(
      'Impact on n8n',
      'The canary takes no more than 20 percent longer than its average over the hour before',
      why,
      '<= 120 %',
      NOT,
    )
    row('Impact on n8n', 'No n8n execution fails during the test', why, '0', NOT)
  } else {
    // The canary's mean in the window against its mean over the hour before (owner ruling R27, 2026-11-19: a
    // single run varies too much to be judged alone; the hour before a test failed the per-run rule by itself).
    // The slowest run is shown for context, not judged.
    const ratio =
      n8n.baselineMeanMs && n8n.windowMeanMs != null ? n8n.windowMeanMs / n8n.baselineMeanMs : null
    row(
      'Impact on n8n',
      'The canary takes no more than 20 percent longer than its average over the hour before',
      ratio == null
        ? `canary runs: ${n8n.baselineRuns} before, ${n8n.windowRuns} during`
        : `mean ${ms(n8n.windowMeanMs)} during (${n8n.windowRuns} runs) = ${(ratio * 100).toFixed(0)} % of the mean before, ${ms(n8n.baselineMeanMs)} (${n8n.baselineRuns} runs); slowest run ${ms(n8n.windowMaxMs)}`,
      '<= 120 %',
      ratio == null ? NOT : verdict(ratio <= SPEC.canaryFactor),
    )
    row(
      'Impact on n8n',
      'No n8n execution fails during the test',
      `${n8n.failed} failed`,
      '0',
      verdict(n8n.failed === 0),
    )
  }
  return rows
}

export function renderResults(meta, rows) {
  const cell = (s) => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ')
  const lines = [
    `# Test 41: load and impact on n8n — ${meta.date}`,
    '',
    `Spec section 17, test 41 (REL-13). Run with \`node tools/load/run.mjs ${meta.args}\`.`,
    `Window: ${meta.start} to ${meta.end} (UTC). Origin: ${meta.origin}. Compose project: ${meta.project}.`,
  ]
  if (!meta.fullWorkload) {
    lines.push(
      '',
      '**This run used a smaller workload or a shorter window than spec 17: it is not test 41.**',
    )
  }
  lines.push(
    '',
    '| Aspect | Criterion | Measured | Limit | Result |',
    '|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${cell(r.aspect)} | ${cell(r.criterion)} | ${cell(r.measured)} | ${cell(r.limit)} | ${r.result} |`,
    ),
    '',
    `Overall: ${rows.some((r) => r.result === FAIL) ? 'FAIL' : rows.some((r) => r.result === NOT) ? 'incomplete (criteria not measured)' : 'PASS'}.`,
    '',
  )
  return lines.join('\n')
}

// --- the product, over HTTP ----------------------------------------------------------------------------------

const errorName = (error) => error?.cause?.code ?? error?.code ?? error?.name ?? 'Error'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Session {
  constructor(base, origin) {
    this.base = base
    this.origin = origin
    this.cookies = new Map()
    this.csrf = null
  }

  async request(method, path, body) {
    const headers = { origin: this.origin }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    if (this.csrf && method !== 'GET') headers['x-csrf-token'] = this.csrf
    const started = performance.now()
    try {
      const res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      for (const line of res.headers.getSetCookie()) {
        const pair = line.split(';')[0] ?? ''
        const at = pair.indexOf('=')
        const name = pair.slice(0, at)
        const value = pair.slice(at + 1)
        if (value === '' || /;\s*Max-Age=0/i.test(line)) this.cookies.delete(name)
        else this.cookies.set(name, value)
      }
      // Timed to the end of the body: what a dashboard waits for.
      const text = await res.text()
      const ms = performance.now() - started
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = null
      }
      return { status: res.status, json, ms }
    } catch (error) {
      return { status: 0, json: null, ms: performance.now() - started, error: errorName(error) }
    }
  }
}

// Signs one test user in with the password and the authenticator code. Better Auth allows 3 sign-ins per 10 s
// from one address, so a 429 waits and tries again.
async function signIn(base, origin, user) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const session = new Session(base, origin)
    const first = await session.request('POST', '/api/auth/sign-in/email', {
      email: user.email,
      password: user.password,
    })
    if (first.status === 429) {
      await sleep(11_000)
      continue
    }
    if (first.status !== 200 || !first.json?.twoFactorRedirect) {
      throw new Error(
        `sign-in answered ${first.status}${first.error ? ` ${first.error}` : ''} (a second factor was expected)`,
      )
    }
    // A code is accepted once per 30 s step: a second sign-in in the same step waits for the next one.
    while (Math.floor(Date.now() / 30_000) === user.lastStep) await sleep(1000)
    user.lastStep = Math.floor(Date.now() / 30_000)
    const second = await session.request('POST', '/api/auth/two-factor/verify-totp', {
      code: totp(user.totpSecret),
    })
    if (second.status === 429) {
      await sleep(11_000)
      continue
    }
    if (second.status !== 200) throw new Error(`the second factor answered ${second.status}`)
    const me = await session.request('GET', '/api/v1/session')
    if (me.status !== 200 || !me.json?.csrfToken) throw new Error(`the session answered ${me.status}`)
    if (!me.json.platformOwner)
      throw new Error('a test user is not a platform owner, so it cannot start summary runs')
    session.csrf = me.json.csrfToken
    return session
  }
  throw new Error('sign-in still rate limited after 4 tries')
}

async function resolveBrand(session, brand) {
  const reply = await session.request('GET', '/api/v1/brands')
  if (reply.status !== 200) throw new Error(`the brand list answered ${reply.status}`)
  const found = (reply.json?.brands ?? []).find((b) => b.id === brand || b.slug === brand)
  if (!found) throw new Error("a test user's brand is not visible to it")
  return { id: found.id, slug: found.slug }
}

// --- docker and /proc ----------------------------------------------------------------------------------------

function sh(file, args, timeout = 20_000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? { ok: false, error: errorName(error) } : { ok: true, out: stdout }),
    )
  })
}

async function projectContainers(project) {
  const r = await sh('docker', [
    'ps',
    '-a',
    '-q',
    '--no-trunc',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ])
  if (!r.ok) return null
  return r.out.split('\n').filter(Boolean)
}

// Name, restart count, state and the out-of-memory flag of each of the project's containers.
async function containerStates(project) {
  const ids = await projectContainers(project)
  if (ids == null) return null
  if (ids.length === 0) return []
  const r = await sh('docker', [
    'inspect',
    '--format',
    '{{.Id}} {{index .Config.Labels "com.docker.compose.service"}} {{.RestartCount}} {{.State.Status}} {{.State.OOMKilled}}',
    ...ids,
  ])
  if (!r.ok) return null
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, service, restarts, status, oom] = line.split(' ')
      return { id, service, restarts: Number(restarts), status, oom: oom === 'true' }
    })
}

// Running product services only: the one-shot ops, backup and offsite services are not part of the limits.
const ONE_SHOT = new Set(['ops', 'backup', 'offsite'])

export function compareContainers(before, after, events = []) {
  const running = (list) => list.filter((c) => !ONE_SHOT.has(c.service) && c.status === 'running')
  const b = new Map(running(before).map((c) => [c.service, c]))
  const problems = []
  for (const c of after.filter((x) => !ONE_SHOT.has(x.service))) {
    const was = b.get(c.service)
    if (!was) continue
    if (c.id !== was.id) problems.push(`${c.service} replaced`)
    else if (c.restarts !== was.restarts)
      problems.push(`${c.service} restarted ${c.restarts - was.restarts} times`)
    if (c.status !== 'running') problems.push(`${c.service} ${c.status}`)
    if (c.oom) problems.push(`${c.service} killed for lack of memory`)
  }
  for (const service of b.keys()) {
    if (!after.some((c) => c.service === service)) problems.push(`${service} gone`)
  }
  for (const e of events) problems.push(`${e.service}: ${e.action}`)
  const unique = [...new Set(problems)]
  return {
    ok: unique.length === 0 && b.size > 0,
    text:
      b.size === 0
        ? 'no running product container found'
        : unique.length
          ? unique.join('; ')
          : `none (${[...b.keys()].sort().join(', ')})`,
  }
}

// Stops, kills and out-of-memory events of the project's containers in the window.
async function containerEvents(project, start, end) {
  const r = await sh('docker', [
    'events',
    '--since',
    String(Math.floor(start / 1000)),
    '--until',
    String(Math.ceil(end / 1000)),
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    'type=container',
    '--format',
    '{{json .}}',
  ])
  if (!r.ok) return null
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((e) => e && ['oom', 'die', 'kill', 'stop', 'restart'].includes(e.Action ?? e.status))
    .map((e) => ({
      service: e.Actor?.Attributes?.['com.docker.compose.service'] ?? 'container',
      action: e.Action ?? e.status,
    }))
    .filter((e) => !ONE_SHOT.has(e.service))
}

// One `docker stats` reading of the project's running product containers (one-shot services left out).
async function dockerSample(project) {
  const r = await sh('docker', [
    'ps',
    '--no-trunc',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    'status=running',
    '--format',
    '{{.ID}} {{.Label "com.docker.compose.service"}}',
  ])
  if (!r.ok) return null
  const ids = r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' '))
    .filter(([, service]) => !ONE_SHOT.has(service))
    .map(([id]) => id)
  if (ids.length === 0) return null
  const stats = await sh('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids])
  if (!stats.ok) return null
  return parseStatsLines(stats.out)
}

// `docker stats --format '{{json .}}'` output -> one reading per container. A line that is not JSON, or whose
// figures are unreadable (a container stopping during the reading shows "--"), is skipped.
export function parseStatsLines(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    try {
      const s = JSON.parse(line)
      const cpu = parseCpu(s.CPUPerc)
      const mem = parseMem(s.MemUsage)
      if (typeof s.Name === 'string' && cpu != null && mem != null) out.push({ name: s.Name, cpu, mem })
    } catch {
      // skipped
    }
  }
  return out
}

function readProc(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// --- n8n -----------------------------------------------------------------------------------------------------

async function n8nGet(settings, path) {
  const res = await fetch(`${settings.url}/api/v1${path}`, {
    headers: { 'x-n8n-api-key': settings.key, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status !== 200) throw new Error(`n8n API answered ${res.status}`)
  return res.json()
}

async function readN8n(settings, window) {
  try {
    let canaryId = settings.canaryId
    if (!canaryId) {
      const found = await n8nGet(settings, `/workflows?name=${encodeURIComponent(CANARY_NAME)}`)
      canaryId = found.data?.find((w) => w.name === CANARY_NAME)?.id
      if (!canaryId) return { error: `no workflow named ${CANARY_NAME}` }
    }
    // Every execution back to the hour before the test, newest first.
    const executions = []
    let cursor = null
    for (let page = 0; page < 400; page += 1) {
      const query = `/executions?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const reply = await n8nGet(settings, query)
      const data = reply.data ?? []
      executions.push(...data)
      cursor = reply.nextCursor
      const oldest = data.length ? Date.parse(data[data.length - 1].startedAt) : -Infinity
      if (!cursor || oldest < window.baselineStart) return n8nFigures(executions, canaryId, window)
    }
    return { error: 'more n8n executions than this tool reads (100 000)' }
  } catch (error) {
    return {
      error:
        error instanceof Error && /^n8n API/.test(error.message)
          ? error.message
          : `n8n API: ${errorName(error)}`,
    }
  }
}

// --- the production jobs: the load-test injector in the core container ------------------------------------

async function coreContainer(project) {
  const r = await sh('docker', [
    'ps',
    '-q',
    '--no-trunc',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    'label=com.docker.compose.service=core',
    '--filter',
    'status=running',
  ])
  return r.ok ? (r.out.split('\n').find(Boolean) ?? null) : null
}

// The injector's arguments name brands and counts only; the superuser's address goes by name in the environment.
function injectorArgs(container, brands, jobs, minutes) {
  return [
    'exec',
    '-i',
    '-e',
    'ADMIN_DATABASE_URL',
    container,
    'node',
    'apps/core/src/load-inject.ts',
    '--load-test',
    '--brands',
    brands.join(','),
    '--jobs',
    String(jobs),
    '--minutes',
    String(minutes),
  ]
}

// Runs the injector; each JSON line it prints goes to `onEvent`. Resolves with its exit code.
function runInjector(args, adminUrl, onEvent) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, {
      env: { ...process.env, ADMIN_DATABASE_URL: adminUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffered = ''
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      let at
      while ((at = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, at)
        buffered = buffered.slice(at + 1)
        try {
          onEvent(JSON.parse(line))
        } catch {
          // not an event line
        }
      }
    })
    // The injector prints error names only; its last line is kept for the log.
    let lastError = ''
    child.stderr.on('data', (chunk) => {
      lastError = String(chunk).trim().split('\n').pop() ?? ''
    })
    child.on('error', (error) => resolve({ code: -1, error: errorName(error) }))
    child.on('close', (code) => resolve({ code, error: lastError.slice(0, 200) }))
  })
}

// --- the run -------------------------------------------------------------------------------------------------

function log(text) {
  process.stdout.write(`[load ${new Date().toISOString().slice(11, 19)}] ${text}\n`)
}

export async function main(argv, env) {
  const options = parseArgs(argv)
  const users = loadUsers(env)
  const n8n = n8nSettings(env)
  const adminUrl = env.ADMIN_DATABASE_URL
  if (!adminUrl) {
    throw new Error(
      'ADMIN_DATABASE_URL is missing: the production jobs are injected with the superuser address',
    )
  }
  const base = options.connect ?? options.origin
  if (!n8n) log('n8n API not configured: the two n8n criteria will be reported "not measured"')

  // The load-test brands exist before the users look for them (the injector makes them when missing).
  const core = await coreContainer(options.project)
  if (!core) throw new Error(`the core container of project ${options.project} is not running`)
  const slugs = users.map((u) => u.brand)
  const prepared = await runInjector(injectorArgs(core, slugs, 0, 0), adminUrl, () => undefined)
  if (prepared.code !== 0) throw new Error(`the injector could not prepare the brands: ${prepared.error}`)

  const actors = []
  for (const [i, user] of users.entries()) {
    const session = await signIn(base, options.origin, user)
    const brand = await resolveBrand(session, user.brand)
    actors.push({ user, session, brand, renewing: null })
    log(`test user ${i + 1} signed in (brand ${brand.slug})`)
  }
  if (actors[0].brand.id === actors[1].brand.id)
    throw new Error('the two test users resolve to the same brand')

  // A session that ends mid-run (401) signs in again, once at a time per user.
  async function call(actor, method, path, body) {
    let reply = await actor.session.request(method, path, body)
    if (reply.status === 401) {
      actor.renewing ??= signIn(base, options.origin, actor.user).finally(() => {
        actor.renewing = null
      })
      actor.session = await actor.renewing.catch(() => actor.session)
      reply = await actor.session.request(method, path, body)
    }
    return reply
  }

  const windowMs = options.minutes * 60_000
  const api = []
  const tracked = []
  const submitted = { jobs: 0, probes: 0 }
  const samples = []
  let dockerWhy = null
  const inFlight = new Set()
  const track = (promise) => {
    inFlight.add(promise)
    promise.finally(() => inFlight.delete(promise))
  }

  const statesBefore = await containerStates(options.project)
  if (statesBefore == null) dockerWhy = 'the Docker CLI is not available here'
  const procStatBefore = readProc('/proc/stat')
  const vmBefore = readProc('/proc/vmstat')
  const start = Date.now()
  const end = start + windowMs
  log(
    `window open for ${options.minutes} min: ${options.jobs} jobs, a probe every ${options.probeEvery} s, ` +
      `${options.users} users, docker stats on project ${options.project}`,
  )

  function submit(kind, n) {
    const actor = actors[n % 2]
    const p = call(actor, 'POST', `/api/v1/brands/${actor.brand.id}/agents/summary/runs`, {
      brief: BRIEF(kind, n + 1),
    }).then((reply) => {
      api.push({ ms: reply.ms, ok: reply.status === 201 })
      if (reply.status === 201 && reply.json?.runId) tracked.push({ kind, actor, runId: reply.json.runId })
      else log(`${kind} ${n + 1} refused: ${reply.status}${reply.error ? ` ${reply.error}` : ''}`)
    })
    track(p)
  }

  const timers = []
  // Production jobs: the injector sends them evenly over the window less its last 60 s, the first at its start.
  const bySlug = new Map(actors.map((a) => [a.brand.slug, a]))
  const injector = runInjector(
    injectorArgs(core, slugs, options.jobs, options.minutes),
    adminUrl,
    (event) => {
      if (event.event === 'load_job' && bySlug.has(event.brand)) {
        submitted.jobs += 1
        tracked.push({ kind: 'job', actor: bySlug.get(event.brand), runId: event.runId })
      } else if (event.event === 'load_job_failed') {
        log(`production job ${event.n} not made: ${event.error}`)
      }
    },
  )
  // Probes: one every probe-every seconds, the first half a gap in, so they do not coincide with the jobs.
  for (
    let n = 0, at = (options.probeEvery * 1000) / 2;
    at < windowMs;
    n += 1, at += options.probeEvery * 1000
  ) {
    timers.push(
      setTimeout(() => {
        submitted.probes += 1
        submit('probe', n)
      }, at),
    )
  }
  // Simulated dashboard users: one GET a second each, on a fixed beat, spread across the second.
  const reads = (brandId) => [
    `/api/v1/brands/${brandId}/home`,
    `/api/v1/brands/${brandId}/status`,
    '/api/v1/brands',
    `/api/v1/brands/${brandId}/runs`,
    '/api/v1/session',
  ]
  for (let u = 0; u < options.users; u += 1) {
    const actor = actors[u % 2]
    let tick = 0
    const beat = () => {
      const path = reads(actor.brand.id)[tick % 5]
      tick += 1
      track(call(actor, 'GET', path).then((reply) => api.push({ ms: reply.ms, ok: reply.status === 200 })))
    }
    timers.push(
      setTimeout(
        () => {
          beat()
          timers.push(setInterval(beat, 1000))
        },
        (u * 1000) / Math.max(1, options.users),
      ),
    )
  }
  // docker stats every 5 s; a sample still running when the next is due is not doubled up.
  let sampling = false
  const sampleTimer = setInterval(async () => {
    if (sampling || statesBefore == null) return
    sampling = true
    try {
      const s = await dockerSample(options.project)
      if (s) samples.push(s)
    } finally {
      sampling = false
    }
  }, DOCKER_EVERY_MS)
  timers.push(sampleTimer)
  const progress = setInterval(
    () =>
      log(
        `${Math.round((Date.now() - start) / 1000)} s: ${submitted.jobs} jobs, ${submitted.probes} probes, ${api.length} requests`,
      ),
    60_000,
  )
  timers.push(progress)

  await sleep(end - Date.now())
  for (const t of timers) {
    clearTimeout(t)
    clearInterval(t)
  }
  await Promise.allSettled([...inFlight])
  const injected = await injector
  if (injected.code !== 0) log(`the injector ended with ${injected.code}: ${injected.error}`)
  const windowEnd = Date.now()
  const procStatAfter = readProc('/proc/stat')
  const vmAfter = readProc('/proc/vmstat')
  log(`window closed: ${submitted.jobs} jobs, ${submitted.probes} probes, ${api.length} requests`)

  // The last runs: wait up to --grace for them to end, from the brands' run lists (no audit entry is written).
  const pending = () => tracked.filter((t) => !t.final)
  const graceEnd = Date.now() + options.grace * 1000
  while (pending().length && Date.now() < graceEnd) {
    for (const actor of actors) {
      const mine = new Map(
        pending()
          .filter((t) => t.actor === actor)
          .map((t) => [t.runId, t]),
      )
      let cursor = null
      for (let page = 0; mine.size && page < 100; page += 1) {
        const reply = await call(
          actor,
          'GET',
          `/api/v1/brands/${actor.brand.id}/runs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        )
        if (reply.status !== 200) break
        for (const run of reply.json.items ?? []) {
          const t = mine.get(run.id)
          if (t && ['succeeded', 'failed', 'needs_manual', 'cancelled'].includes(run.state)) {
            t.final = run
            mine.delete(run.id)
          }
        }
        cursor = reply.json.nextCursor
        if (!cursor || Date.parse(reply.json.items?.at(-1)?.startedAt) < start - 60_000) break
      }
    }
    if (pending().length) await sleep(5000)
  }

  // The details of every run this test started (each read is audited as an owner read), four at a time.
  const jobs = []
  const modelMs = []
  let unread = 0
  for (let i = 0; i < tracked.length; i += 4) {
    await Promise.all(
      tracked.slice(i, i + 4).map(async (t) => {
        const reply = await call(t.actor, 'GET', `/api/v1/brands/${t.actor.brand.id}/runs/${t.runId}`)
        if (reply.status !== 200) {
          unread += 1
          return
        }
        t.detail = reply.json
        jobs.push(...jobsOf(reply.json, t.actor.brand.id, t.kind))
        for (const c of reply.json.modelCalls ?? []) {
          if (c.finishedAt) modelMs.push(Date.parse(c.finishedAt) - Date.parse(c.startedAt))
        }
      }),
    )
  }
  if (unread) log(`${unread} run details could not be read`)

  let dead = 0
  for (const actor of actors) {
    const reply = await call(actor, 'GET', `/api/v1/brands/${actor.brand.id}/jobs/dead`)
    if (reply.status !== 200) {
      dead = null
      break
    }
    const list = Array.isArray(reply.json) ? reply.json : (reply.json?.items ?? [])
    dead += list.length
  }

  const statesAfter = statesBefore == null ? null : await containerStates(options.project)
  const events = statesBefore == null ? null : await containerEvents(options.project, start, windowEnd)

  let n8nResult = null
  if (n8n) {
    // The canary runs each minute: wait for the one started last in the window to be recorded.
    await sleep(Math.max(0, windowEnd + 65_000 - Date.now()))
    n8nResult = await readN8n(n8n, { baselineStart: start - 3_600_000, start, end: windowEnd })
  }

  // Figures.
  const latencies = api.map((a) => a.ms)
  const probeJobs = jobs.filter((j) => j.kind === 'probe' && j.summary)
  const probeWaits = probeJobs.map((j) => (j.claimedAt == null ? Infinity : j.claimedAt - j.createdAt))
  // The injected runs' first jobs, production class; the occupancy counts every job read, by brand and class.
  const isProduction = (j) => j.kind === 'job' && j.summary && j.class === 'production'
  const loadJobs = jobs.filter(isProduction)
  const allWaits = slotWaits(jobs, { ...BRAND_CAPS, production: options.slotCap })
  const loadSlotWaits = jobs
    .map((j, i) => ({ j, w: allWaits[i] }))
    .filter(({ j }) => isProduction(j))
    .map(({ w }) => w)
  const loadWaits = loadJobs.map((j) => (j.claimedAt == null ? Infinity : j.claimedAt - j.createdAt))
  const loadRuns = tracked.filter((t) => t.kind === 'job')
  const finishedAt = (t) =>
    t.detail?.run?.state === 'succeeded' ? Date.parse(t.detail.run.finishedAt) : null
  const measured = {
    options,
    brands: new Set(actors.map((a) => a.brand.id)).size,
    submitted,
    windowMs: windowEnd - start,
    modelMedianMs: percentile(modelMs, 0.5),
    docker: statesBefore == null ? null : summarizeDocker(samples),
    dockerWhy: dockerWhy ?? (samples.length ? null : 'no docker stats sample'),
    containers:
      statesBefore == null || statesAfter == null
        ? null
        : compareContainers(statesBefore, statesAfter, events ?? []),
    serverCpu: procStatBefore && procStatAfter ? cpuBusy(procStatBefore, procStatAfter) : null,
    swapPages: vmBefore && vmAfter ? swapPages(vmBefore, vmAfter) : null,
    api: {
      count: latencies.length,
      failed: api.filter((a) => !a.ok).length,
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    probes: {
      count: probeWaits.length,
      withinShare: probeWaits.length
        ? probeWaits.filter((w) => w <= SPEC.probeClaimMs).length / probeWaits.length
        : 0,
      p95: percentile(probeWaits, 0.95),
      max: probeWaits.length ? Math.max(...probeWaits) : null,
    },
    production: {
      count: loadJobs.length,
      maxSlotWait: loadSlotWaits.length ? Math.max(...loadSlotWaits) : null,
      p95Wait: percentile(loadWaits, 0.95),
      maxWait: loadWaits.length ? Math.max(...loadWaits) : null,
      finishedInWindow: loadRuns.filter((t) => finishedAt(t) != null && finishedAt(t) <= windowEnd).length,
      finishedByGrace: loadRuns.filter((t) => finishedAt(t) != null).length,
    },
    dead,
    n8n: n8nResult,
  }
  const rows = evaluate(measured)
  const meta = {
    date: new Date(start).toISOString().slice(0, 10),
    start: new Date(start).toISOString().slice(0, 19).replace('T', ' '),
    end: new Date(windowEnd).toISOString().slice(0, 19).replace('T', ' '),
    origin: '(set)',
    project: options.project,
    args: maskArgs(argv),
    fullWorkload:
      options.minutes === SPEC.minutes &&
      options.jobs === SPEC.jobs &&
      options.users === SPEC.users &&
      options.probeEvery === SPEC.probeEvery,
  }
  const markdown = renderResults(meta, rows)
  process.stdout.write(`\n${markdown}`)
  if (options.results) {
    writeFileSync(options.results, markdown, { mode: 0o644 })
    log(`results written to ${options.results}`)
  }
  return rows
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).then(
    (rows) => {
      process.exitCode = rows.some((r) => r.result === FAIL) ? 1 : 0
      // Keep-alive sockets would hold the process open.
      setImmediate(() => process.exit())
    },
    (error) => {
      const message = error instanceof Error ? error.message : ''
      // Our own messages name an argument, a variable or a status; anything else is reported by name only.
      const ours =
        /^(--|LOAD_|N8N_|ADMIN_DATABASE_URL|two test users|test user|each test user|the |a test user|sign-in|unknown argument)/.test(
          message,
        )
      process.stderr.write(
        `load test failed: ${ours ? message : errorName(error)}\n${ours && message.startsWith('--') ? `${USAGE}\n` : ''}`,
      )
      process.exit(2)
    },
  )
}
