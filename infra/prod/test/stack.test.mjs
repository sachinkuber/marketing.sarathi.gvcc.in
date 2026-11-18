// The production compose file, run (plan, Task 5 step 4): the whole stack comes up under the project name
// mkt-m7test with secrets generated for this run, `prepare` readies the database, the core answers on
// 127.0.0.1:4100, the owner bootstrap works, and a restart of the whole stack while five summary jobs wait
// loses none of them.
// Needs Docker with the Compose plugin, and ports 4100 and 3100 free on 127.0.0.1. It fails, never skips,
// without them. On the development server it runs through /opt/mkt-dev/server-run-infra.sh (host network);
// in CI in the e2e job.
//   node --test infra/prod/test/stack.test.mjs
// The secrets live in a 0700 temporary folder (files 0600) and are deleted afterwards; no value is printed.
// `down -v` removes the project's containers, networks and volume whether the tests pass or fail. The images
// it builds (mkt-m7test-<service>) are kept, so the next run reuses them and their build cache.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const composeFile = join(root, 'infra/prod/compose.yaml')
const PROJECT = 'mkt-m7test'
const CORE = 'http://127.0.0.1:4100'
const OWNER = 'owner@example.test'
const JOBS = 5
const TEST_EGRESS = { MKT_EGRESS_BRIDGE: 'mkt-m7t-egress0', MKT_EGRESS_SUBNET: '10.247.74.0/24' }

// Hex keeps every value valid inside a database URL and within the role-password rules.
const secret = () => randomBytes(32).toString('hex')
const values = {
  postgres: secret(),
  app: secret(),
  auditWriter: secret(),
  queue: secret(),
  ownerView: secret(),
  auth: secret(),
  worker: secret(),
  attempt: secret(),
  trigger: secret(),
}
const db = (user, password) => `postgres://${user}:${password}@postgres:5432/mkt`
const adminUrl = db('postgres', values.postgres)
let secretsDir

// Output shown on a failure goes through this first: no generated value can reach a log.
function redact(text) {
  let out = String(text ?? '')
  for (const value of Object.values(values)) out = out.split(value).join('[secret]')
  return out
}

function run(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
    // Its own egress bridge and subnet, so it can run beside a `mkt` stack on the same host; no firewall is
    // installed for it.
    env: { ...process.env, MKT_SECRETS: secretsDir, ...TEST_EGRESS, ...options.env },
  })
  return result
}

// `ops: true` adds the ops profile (building and running ops, and taking everything down); without it `up` and
// `restart` act on the four product services only.
function compose(args, options = {}) {
  const profile = options.ops ? ['--profile', 'ops'] : []
  const result = run(['compose', '-p', PROJECT, '-f', composeFile, ...profile, ...args], options)
  if (result.status !== 0) {
    const output = redact(`${result.stdout ?? ''}${result.stderr ?? ''}`)
      .trim()
      .split('\n')
      .slice(-40)
      .join('\n')
    throw new Error(`docker compose ${args.join(' ')} failed (${result.status ?? result.error}):\n${output}`)
  }
  return result.stdout
}

// SQL as the database superuser, over the container's local socket (no password on any command line).
function psql(sql) {
  return compose(
    [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'mkt',
      '-v',
      'ON_ERROR_STOP=1',
      '-AtX',
      '-f',
      '-',
    ],
    {
      input: sql,
    },
  ).trim()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what, check, ms) {
  const end = Date.now() + ms
  for (;;) {
    if (await check()) return
    if (Date.now() > end) throw new Error(`${what}: not reached in ${ms / 1000} s`)
    await sleep(1000)
  }
}

const status = (path) =>
  fetch(`${CORE}${path}`, { signal: AbortSignal.timeout(5000) }).then(
    (response) => response.status,
    () => 0,
  )

function writeEnv(name, lines) {
  const file = join(secretsDir, `${name}.env`)
  writeFileSync(
    file,
    `${Object.entries(lines)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`,
    { mode: 0o600 },
  )
  chmodSync(file, 0o600)
}

before(() => {
  for (const args of [
    ['version', '--format', '{{.Server.Version}}'],
    ['compose', 'version'],
  ]) {
    if (run(args).status !== 0)
      throw new Error(`docker ${args[0]} failed. These tests need Docker and Compose and never skip.`)
  }
  secretsDir = mkdtempSync(join(tmpdir(), 'mkt-stack-'))
  chmodSync(secretsDir, 0o700)
  writeEnv('postgres', { POSTGRES_PASSWORD: values.postgres, ADMIN_DATABASE_URL: adminUrl })
  writeEnv('roles', {
    MKT_APP_PASSWORD: values.app,
    MKT_AUDIT_WRITER_PASSWORD: values.auditWriter,
    MKT_QUEUE_PASSWORD: values.queue,
    MKT_OWNER_VIEW_PASSWORD: values.ownerView,
  })
  writeEnv('core', {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    DATABASE_URL: db('mkt_app', values.app),
    AUDIT_DATABASE_URL: db('mkt_audit_writer', values.auditWriter),
    QUEUE_DATABASE_URL: db('mkt_queue', values.queue),
    OWNER_VIEW_DATABASE_URL: db('mkt_owner_view', values.ownerView),
    AUTH_SECRET: values.auth,
    WORKER_SECRET: values.worker,
    ATTEMPT_TOKEN_SECRET: values.attempt,
    TRIGGER_SECRET: values.trigger,
    QUEUE_BACKLOG_LIMIT: '2000',
    PUBLIC_ORIGIN: 'https://stack.example.test',
    TRUST_PROXY: '1',
    N8N_HEARTBEAT_EXPECTED: 'false',
  })
  // The stand-in model, which the worker accepts only under NODE_ENV=test: no provider is called.
  writeEnv('worker', {
    NODE_ENV: 'test',
    MODEL_BACKEND: 'standin',
    QUEUE_DATABASE_URL: db('mkt_queue', values.queue),
    WORKER_SECRET: values.worker,
  })
  writeEnv('dashboard', { NODE_ENV: 'production' })
  // A stack left by an interrupted run would hold the ports and the old volume.
  compose(['down', '-v', '--remove-orphans'], { ops: true })
})

after(() => {
  try {
    if (secretsDir) compose(['down', '-v', '--remove-orphans'], { ops: true })
  } finally {
    if (secretsDir) rmSync(secretsDir, { recursive: true, force: true })
  }
})

test(
  'the stack builds, prepares and starts; the core answers on 127.0.0.1:4100',
  { timeout: 90 * 60_000 },
  async (t) => {
    // One image at a time: the host's processors are shared with other projects.
    for (const service of ['core', 'worker', 'dashboard', 'ops']) compose(['build', service], { ops: true })
    compose(['up', '-d', '--wait', 'postgres'])
    const prepared = compose(['run', '--rm', 'ops'], { ops: true })
    const line = JSON.parse(prepared.trim().split('\n').pop())
    assert.equal(line.event, 'prepared')
    t.diagnostic(`prepare: ${line.migrated.length} migrations, queues ${line.queues.join(', ')}`)
    compose(['up', '-d', '--wait', '--wait-timeout', '300'])
    assert.equal(await status('/api/health/ready'), 200)
    assert.equal(await status('/health/live'), 200)
    // Published on the loopback address only; the data and worker networks have no route out.
    assert.equal(compose(['port', 'core', '4000']).trim(), '127.0.0.1:4100')
    assert.equal(compose(['port', 'dashboard', '3000']).trim(), '127.0.0.1:3100')
    const egress = run([
      'network',
      'inspect',
      '--format',
      '{{index .Options "com.docker.network.bridge.name"}} {{range .IPAM.Config}}{{.Subnet}}{{end}}',
      `${PROJECT}_worker_egress`,
    ])
    assert.equal(egress.stdout.trim(), `${TEST_EGRESS.MKT_EGRESS_BRIDGE} ${TEST_EGRESS.MKT_EGRESS_SUBNET}`)
    for (const network of ['data', 'worker']) {
      const internal = run(['network', 'inspect', '--format', '{{.Internal}}', `${PROJECT}_${network}`])
      assert.equal(internal.stdout.trim(), 'true', network)
    }
    const dashboard = await fetch('http://127.0.0.1:3100/', { signal: AbortSignal.timeout(5000) })
    assert.equal(dashboard.status, 200)
  },
)

test('the bootstrap command creates the owner', () => {
  // The superuser's address reaches the command through the environment of `docker compose exec`, by name.
  const bootstrap = () =>
    compose(
      [
        'exec',
        '-T',
        '-e',
        'BOOTSTRAP_DATABASE_URL',
        'core',
        'node',
        'apps/core/src/bootstrap.ts',
        '--owner-email',
        OWNER,
      ],
      { env: { BOOTSTRAP_DATABASE_URL: adminUrl } },
    )
  // The temporary password is in this output: it is matched, never printed.
  assert.ok(
    /Temporary password for the platform owner/.test(bootstrap()),
    'no temporary password was printed',
  )
  assert.equal(
    psql(
      `select count(*) from app.platform_owner o join auth."user" u on u.id = o.user_id where u.email = '${OWNER}'`,
    ),
    '1',
  )
  assert.match(bootstrap(), /already exists/)
})

test(
  'a restart of the whole stack while 5 summary jobs wait: all 5 finish and none is dead',
  { timeout: 15 * 60_000 },
  async (t) => {
    // Prices and a rate for the stand-in's usage, as the e2e test enters them.
    psql(`insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, source)
          values ('claude-opus-5-5', current_date - 30, 4000000, 20000000, 200000, 5000000, 'test');
        select app.record_fx_rate(current_date - 1, 83500000, 'test');`)
    const brandId = psql(`select id from app.brand where slug = 'test-brand'`)
    const ownerId = psql(
      `select o.user_id from app.platform_owner o join auth."user" u on u.id = o.user_id where u.email = '${OWNER}'`,
    )
    assert.ok(brandId && ownerId)

    // No worker takes them: the jobs wait in the queue.
    compose(['stop', 'worker'])
    // Started the way the route starts them (run, job and audit entry in one transaction), with the core's own
    // roles, inside the core container.
    const script = `
    import { createPool } from '@mkt/db'
    import { openQueue } from '@mkt/queue'
    import { DbAudit } from 'file:///app/apps/core/src/audit/db-audit.ts'
    import { startSummaryRun } from 'file:///app/apps/core/src/agents/start.ts'
    const pool = createPool(process.env.DATABASE_URL, { max: 2 })
    const auditPool = createPool(process.env.AUDIT_DATABASE_URL, { max: 2 })
    const queue = await openQueue(process.env.QUEUE_DATABASE_URL)
    const runs = []
    try {
      for (let i = 1; i <= ${JOBS}; i++) {
        runs.push(await startSummaryRun(pool, { queue, backlogLimit: 2000, audit: new DbAudit(auditPool) }, {
          brandId: process.env.BRAND_ID,
          brief: 'Stack test ' + i + ': the monsoon range, two lines, friendly tone.',
          actor: { userId: process.env.OWNER_ID },
        }))
      }
    } finally {
      await queue.stop()
      await pool.end()
      await auditPool.end()
    }
    process.stdout.write(JSON.stringify(runs))`
    const runs = JSON.parse(
      compose(
        [
          'exec',
          '-T',
          '-e',
          `BRAND_ID=${brandId}`,
          '-e',
          `OWNER_ID=${ownerId}`,
          'core',
          'node',
          '--input-type=module',
          '-',
        ],
        { input: script },
      ),
    )
    assert.equal(runs.length, JOBS)
    const jobIds = runs.map((r) => `'${r.jobId}'`).join(',')
    const runIds = runs.map((r) => `'${r.runId}'`).join(',')
    assert.equal(
      psql(`select string_agg(distinct state::text, ',') from pgboss.job where id in (${jobIds})`),
      'created',
    )
    assert.equal(psql(`select count(*) from pgboss.job where id in (${jobIds})`), String(JOBS))

    // The whole stack, the stopped worker included.
    compose(['restart'])
    await until('the core is ready again', async () => (await status('/api/health/ready')) === 200, 180_000)

    const finished = () =>
      psql(`select count(*) from app.run where id in (${runIds}) and state = 'succeeded'`)
    await until('all five runs succeed', async () => finished() === String(JOBS), 300_000).catch((error) => {
      t.diagnostic(redact(psql(`select state, count(*) from app.run where id in (${runIds}) group by state`)))
      t.diagnostic(
        redact(run(['compose', '-p', PROJECT, '-f', composeFile, 'logs', '--tail', '40', 'worker']).stdout),
      )
      throw error
    })
    // None dead (the summary jobs and the check jobs they led to), none still active, one model call per run.
    assert.equal(
      psql(`select count(*) from app.job_control c join app.job_input j on j.job_id = c.job_id
           where j.run_id in (${runIds}) and c.dead_at is not null`),
      '0',
    )
    assert.equal(psql(`select count(*) from app.job_input where run_id in (${runIds})`), String(2 * JOBS))
    assert.equal(
      psql(`select count(*) from app.job_input where run_id in (${runIds}) and finished_at is null`),
      '0',
    )
    assert.equal(
      psql(`select string_agg(distinct state::text, ',') from pgboss.job where id in (${jobIds})`),
      'completed',
    )
    assert.equal(
      psql(`select count(*) from app.model_call where run_id in (${runIds}) and status = 'succeeded'`),
      String(JOBS),
    )
    assert.equal(psql(`select count(*) from app.model_call where run_id in (${runIds})`), String(JOBS))
    assert.equal(await status('/api/health/ready'), 200)
  },
)
