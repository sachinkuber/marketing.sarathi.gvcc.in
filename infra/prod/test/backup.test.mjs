// Backups (plan, Task 8; decision 6): infra/prod/backup/backup.sh and restore.sh in the `backup` service (the ops
// image), the `ops alert` command the backup unit's OnFailure= runs, and the systemd units themselves.
// A throw-away stack (project mkt-m7test-bk: postgres, plus the core, ops and backup images run one-shot) is
// seeded the way production is (prepare, the owner bootstrap, audit entries through the core's DbAudit), backed
// up, and restored into separate clean postgres containers (mkt-m7test-bk-target-*), where the row counts of
// app, auth, audit and pgboss are compared and the audit chains are checked with the core's verifyAudit.
// Needs Docker with the Compose plugin. It fails, never skips, without them. On the development server it runs
// through /opt/mkt-dev/server-run-infra.sh (host network); in CI in the e2e job.
//   node --test infra/prod/test/backup.test.mjs
// The age key pairs are generated for this run; the private keys exist only in this process and in the test's
// backup folders, which are removed afterwards with the stack (`down -v`) and the target containers. The backup
// folders are host paths (/tmp/mkt-m7test-bk-<pid>-<hex>/...): Docker creates them for the bind mount, and they
// are read and removed only through containers. No generated value is printed. The images it builds
// (mkt-m7test-bk-<service>) are kept, like stack.test.mjs's, so the next run reuses them.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const composeFile = join(root, 'infra/prod/compose.yaml')
const PROJECT = 'mkt-m7test-bk'
const OWNER = 'owner@example.test'
// Its own egress bridges and subnets (the worker's and the backup upload's), so it can run beside a `mkt` stack.
const TEST_EGRESS = {
  MKT_EGRESS_BRIDGE: 'mkt-m7t-egress0',
  MKT_EGRESS_SUBNET: '10.247.74.0/24',
  MKT_BACKUP_EGRESS_BRIDGE: 'mkt-m7t-bkegr0',
  MKT_BACKUP_EGRESS_SUBNET: '10.247.76.0/24',
}
const SCHEMAS = ['app', 'auth', 'audit', 'pgboss']
// The same postgres image as the stack, by digest.
const PG_IMAGE = readFileSync(composeFile, 'utf8').match(/^\s+image: (postgres@sha256:[0-9a-f]{64})$/m)[1]
const HOST_BASE = `/tmp/${PROJECT}-${process.pid}-${randomBytes(4).toString('hex')}`
const MAIN_DIR = `${HOST_BASE}/main`

const secret = () => randomBytes(32).toString('hex')
const values = {
  postgres: secret(),
  target: secret(),
  app: secret(),
  auditWriter: secret(),
  queue: secret(),
  ownerView: secret(),
  auth: secret(),
  worker: secret(),
  attempt: secret(),
  trigger: secret(),
}
const db = (user, password, host = 'postgres') => `postgres://${user}:${password}@${host}:5432/mkt`
const adminUrl = db('postgres', values.postgres)
const targets = []
let secretsDir
let identity
let recipient

function redact(text) {
  let out = String(text ?? '')
  for (const value of [...Object.values(values), identity].filter(Boolean))
    out = out.split(value).join('[secret]')
  return out.replace(/AGE-SECRET-KEY-[0-9A-Z]+/g, '[secret]')
}

function docker(args, options = {}) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
    env: {
      ...process.env,
      MKT_SECRETS: secretsDir,
      MKT_BACKUP_DIR: MAIN_DIR,
      ...TEST_EGRESS,
      ...options.env,
    },
  })
}

const output = (result) =>
  redact(`${result.stdout ?? ''}${result.stderr ?? ''}`)
    .trim()
    .split('\n')
    .slice(-40)
    .join('\n')

// docker compose for the test project, with the ops profile (ops and backup are in it). `check: false` returns
// the result of a command expected to fail.
function compose(args, options = {}) {
  const result = docker(['compose', '-p', PROJECT, '-f', composeFile, '--profile', 'ops', ...args], options)
  if (options.check !== false && result.status !== 0) {
    throw new Error(`docker compose ${args[0]} failed (${result.status ?? result.error}):\n${output(result)}`)
  }
  return options.check === false ? result : result.stdout
}

// A shell in the backup image with a backup folder at /backups, without starting postgres.
const inBackup = (dir, script, options = {}) =>
  compose(['run', '--rm', '-T', '--no-deps', '--entrypoint', 'sh', 'backup', '-c', script], {
    ...options,
    env: { MKT_BACKUP_DIR: dir, ...options.env },
  })

// A new folder for backups: created by Docker as root 0755, then 0700 as the runbook installs it.
function backupDir(name) {
  const dir = `${HOST_BASE}/${name}`
  inBackup(dir, 'chmod 0700 /backups')
  return dir
}

const listing = (dir) => inBackup(dir, 'cd /backups && ls -1A').trim().split('\n').filter(Boolean).sort()

// The offsite service (offsite.sh): /backups read-only, a host folder at /remote standing in for the bucket
// (a local path is an rclone remote like any other).
const runOffsite = (dir, remoteDir, env = {}, check = true, mounts = []) =>
  compose(
    [
      'run',
      '--rm',
      '-T',
      '--no-deps',
      '-v',
      `${remoteDir}:/remote`,
      ...mounts.flatMap((m) => ['-v', m]),
      ...Object.keys(env).flatMap((k) => ['-e', k]),
      'offsite',
    ],
    { env: { MKT_BACKUP_DIR: dir, ...env }, check },
  )

const runBackup = (dir, env = {}, check = true) =>
  compose(['run', '--rm', '-T', ...Object.keys(env).flatMap((k) => ['-e', k]), 'backup'], {
    env: { MKT_BACKUP_DIR: dir, ...env },
    check,
  })

// SQL as the superuser over a container's local socket: the stack's postgres, or a target container.
function psqlArgs() {
  return ['psql', '-U', 'postgres', '-d', 'mkt', '-v', 'ON_ERROR_STOP=1', '-AtX', '-f', '-']
}
const psql = (sql) => compose(['exec', '-T', 'postgres', ...psqlArgs()], { input: sql }).trim()
function psqlIn(container, sql) {
  const result = docker(['exec', '-i', container, ...psqlArgs()], { input: sql })
  if (result.status !== 0) throw new Error(`psql in ${container} failed:\n${output(result)}`)
  return result.stdout.trim()
}

// Every table's row count in the four schemas, as {"schema.table": n}.
const COUNTS = `select table_schema || '.' || table_name || '=' ||
    (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name),
      false, true, '')))[1]::text
  from information_schema.tables
 where table_schema in (${SCHEMAS.map((s) => `'${s}'`).join(', ')}) and table_type = 'BASE TABLE'
 order by 1`
const parseCounts = (text) =>
  Object.fromEntries(
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, n] = line.split('=')
        return [name, Number(n)]
      }),
  )
const perSchema = (counts) =>
  Object.fromEntries(
    SCHEMAS.map((s) => [
      s,
      Object.entries(counts)
        .filter(([k]) => k.startsWith(`${s}.`))
        .reduce((sum, [, n]) => sum + n, 0),
    ]),
  )

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A clean postgres (the stack's image) on the project's data network, where the backup service reaches it.
async function startTarget(name) {
  const container = `${PROJECT}-target-${name}`
  docker(['rm', '-f', container])
  targets.push(container)
  const started = docker(
    [
      'run',
      '-d',
      '--name',
      container,
      '--network',
      `${PROJECT}_data`,
      '--shm-size',
      '256m',
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      'POSTGRES_DB=mkt',
      PG_IMAGE,
    ],
    { env: { POSTGRES_PASSWORD: values.target } },
  )
  if (started.status !== 0) throw new Error(`target ${container} did not start:\n${output(started)}`)
  // Over TCP: the image's first-start server listens on the socket only, so a socket check passes too early.
  const end = Date.now() + 120_000
  while (
    docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'mkt']).status !== 0
  ) {
    if (Date.now() > end) throw new Error(`target ${container} not ready in 120 s`)
    await sleep(1000)
  }
  return container
}

const targetUrl = (container) => `postgres://postgres@${container}:5432/mkt`

// restore.sh in the backup image. The target's password reaches it by name (PGPASSWORD), never on a command line.
const restore = (dir, set, container, check = true) =>
  compose(
    [
      'run',
      '--rm',
      '-T',
      '--no-deps',
      '-e',
      'PGPASSWORD',
      '-e',
      'AGE_IDENTITY_FILE=/backups/.test-identity',
      '--entrypoint',
      'mkt-restore',
      'backup',
      `/backups/${set}.dump.age`,
      `/backups/${set}.roles.sql.age`,
      targetUrl(container),
    ],
    {
      env: { MKT_BACKUP_DIR: dir, PGPASSWORD: container === 'postgres' ? values.postgres : values.target },
      check,
    },
  )

const putIdentity = (dir, name = '.test-identity', key = identity) =>
  inBackup(dir, `umask 077 && cat > /backups/${name}`, { input: `${key}\n` })

// A script run with the core's image and code (compose run: no port is published, the core does not start).
function coreScript(script, env = {}) {
  return compose(
    [
      'run',
      '--rm',
      '-T',
      ...Object.keys(env).flatMap((k) => ['-e', k]),
      'core',
      'node',
      '--input-type=module',
      '-',
    ],
    { input: script, env },
  )
}

const AUDIT_WRITES = `
import { createPool } from '@mkt/db'
import { DbAudit } from 'file:///app/apps/core/src/audit/db-audit.ts'
const pool = createPool(process.env.AUDIT_DATABASE_URL, { max: Number(process.env.LANES) })
const audit = new DbAudit(pool)
const chains = JSON.parse(process.env.CHAINS)
const total = Number(process.env.WRITES)
const pause = Number(process.env.PAUSE_MS)
const times = []
let next = 0
async function lane() {
  while (next < total) {
    const i = next++
    await audit.record({ brandId: chains[i % chains.length], actor: null, actorKind: 'system',
      action: 'backup_test.write', outcome: 'success', subject: 'write ' + i, detail: { i } })
    times.push(Date.now())
    if (times.length === 1) process.stdout.write('first\\n')
    await new Promise((r) => setTimeout(r, pause))
  }
}
try {
  await Promise.all(Array.from({ length: Number(process.env.LANES) }, lane))
} finally {
  await pool.end()
}
process.stdout.write(JSON.stringify({ n: times.length, first: Math.min(...times), last: Math.max(...times) }) + '\\n')`

const VERIFY = `
import { createPool } from '@mkt/db'
import { verifyAudit } from 'file:///app/apps/core/src/audit/verify.ts'
const reader = createPool(process.env.OWNER_VIEW_DATABASE_URL, { max: 2 })
try {
  const result = await verifyAudit({ reader, store: null })
  process.stdout.write(JSON.stringify({ ok: result.ok, chains: result.chains, findings: result.findings.length }) + '\\n')
} finally {
  await reader.end()
}`

const lastJson = (text) => JSON.parse(text.trim().split('\n').pop())

// The audit chains of a database, checked by the core's verifyAudit as the owner-view role.
function verifyChains(host) {
  const url = db('mkt_owner_view', values.ownerView, host)
  return lastJson(coreScript(VERIFY, { OWNER_VIEW_DATABASE_URL: url }))
}

// After a restore the roles have no passwords (pg_dumpall --no-role-passwords): `prepare` gives them theirs, as
// the runbook says, and finds no migration to run.
function prepareTarget(container) {
  const line = lastJson(
    compose(['run', '--rm', '-T', '--no-deps', '-e', 'ADMIN_DATABASE_URL', 'ops', 'prepare'], {
      env: { ADMIN_DATABASE_URL: db('postgres', values.target, container) },
    }),
  )
  assert.equal(line.event, 'prepared')
  assert.deepEqual(line.migrated, [])
}

// The newest backup set in a folder: mkt-<UTC timestamp>.
const sets = (dir) =>
  listing(dir)
    .map((f) => f.match(/^(mkt-\d{8}T\d{6}Z)\.dump\.age$/)?.[1])
    .filter(Boolean)
    .sort()

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

function keyPair() {
  const out = compose(['run', '--rm', '-T', '--no-deps', '--entrypoint', 'age-keygen', 'backup'])
  const key = out.match(/^AGE-SECRET-KEY-[0-9A-Z]+$/m)?.[0]
  const pub = out.match(/^# public key: (age1[0-9a-z]+)$/m)?.[1]
  assert.ok(key && pub, 'age-keygen printed no key pair')
  return { key, pub }
}

let brandId

before(() => {
  for (const args of [
    ['version', '--format', '{{.Server.Version}}'],
    ['compose', 'version'],
  ]) {
    if (spawnSync('docker', args).status !== 0)
      throw new Error(`docker ${args[0]} failed. These tests need Docker and Compose and never skip.`)
  }
  secretsDir = mkdtempSync(join(tmpdir(), 'mkt-backup-'))
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
    PUBLIC_ORIGIN: 'https://backup.example.test',
    TRUST_PROXY: '1',
    N8N_HEARTBEAT_EXPECTED: 'false',
  })
  writeEnv('worker', { NODE_ENV: 'test', MODEL_BACKEND: 'standin', WORKER_SECRET: values.worker })
  writeEnv('dashboard', { NODE_ENV: 'production' })
  // Replaced once the key pair exists (compose reads every env file of the services it runs).
  writeEnv('backup', { BACKUP_AGE_RECIPIENT: 'CHANGE_ME' })
  compose(['down', '-v', '--remove-orphans'])
})

after(() => {
  try {
    for (const container of targets) docker(['rm', '-f', '-v', container])
    if (secretsDir) {
      // The test's backup folders, through a container (they are root's, on the host).
      docker([
        'compose',
        '-p',
        PROJECT,
        '-f',
        composeFile,
        '--profile',
        'ops',
        'run',
        '--rm',
        '-T',
        '--no-deps',
        '-v',
        '/tmp:/host-tmp',
        '--entrypoint',
        'sh',
        'backup',
        '-c',
        `chmod -R u+w /host-tmp/${HOST_BASE.slice('/tmp/'.length)}; rm -rf /host-tmp/${HOST_BASE.slice('/tmp/'.length)}`,
      ])
      compose(['down', '-v', '--remove-orphans'], { check: false })
    }
  } finally {
    if (secretsDir) rmSync(secretsDir, { recursive: true, force: true })
  }
})

test('the stack is seeded: prepare, the owner bootstrap and audit entries', { timeout: 60 * 60_000 }, () => {
  // One image at a time: the host's processors are shared.
  // offsite too: the tests of offsite.sh must run the script in the working tree, not an older image of it.
  for (const service of ['core', 'ops', 'backup', 'offsite']) compose(['build', service])
  ;({ key: identity, pub: recipient } = keyPair())
  writeEnv('backup', { BACKUP_AGE_RECIPIENT: recipient })
  compose(['up', '-d', '--wait', 'postgres'])
  assert.equal(lastJson(compose(['run', '--rm', '-T', 'ops', 'prepare'])).event, 'prepared')
  compose(
    [
      'run',
      '--rm',
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
  brandId = psql(`select id from app.brand where slug = 'test-brand'`)
  assert.ok(brandId)
  const done = lastJson(
    coreScript(AUDIT_WRITES, {
      CHAINS: JSON.stringify([brandId, null]),
      WRITES: '20',
      LANES: '4',
      PAUSE_MS: '0',
    }),
  )
  assert.equal(done.n, 20)
  const counts = perSchema(parseCounts(psql(COUNTS)))
  for (const schema of SCHEMAS) assert.ok(counts[schema] > 0, `${schema} has no rows to back up`)
  assert.deepEqual(verifyChains('postgres'), { ok: true, chains: 2, findings: 0 })
})

let firstSet

test(
  'backup then restore into a clean postgres gives the same row counts in app, auth, audit and pgboss',
  { timeout: 15 * 60_000 },
  async (t) => {
    const dir = backupDir('main')
    const before = parseCounts(psql(COUNTS))
    const result = runBackup(dir)
    assert.match(result, /"event":"backup_done"/)
    // The backup makes no off-server copy itself (the offsite service does).
    assert.doesNotMatch(result, /offsite/)
    ;[firstSet] = sets(dir)
    assert.ok(firstSet, 'no backup set was written')
    assert.deepEqual(
      listing(dir).filter((f) => f.startsWith(firstSet)),
      [
        `${firstSet}.dump.age`,
        `${firstSet}.dump.age.sha256`,
        `${firstSet}.roles.sql.age`,
        `${firstSet}.roles.sql.age.sha256`,
      ],
    )
    // Nothing half-written is left, and the checksums hold.
    assert.deepEqual(
      listing(dir).filter((f) => f.endsWith('.part')),
      [],
    )
    inBackup(
      dir,
      `cd /backups && sha256sum -c --status ${firstSet}.dump.age.sha256 ${firstSet}.roles.sql.age.sha256`,
    )
    // The files are root's and private, in a private folder.
    assert.equal(
      inBackup(dir, `stat -c '%a %u' /backups /backups/${firstSet}.dump.age`).trim(),
      '700 0\n600 0',
    )

    putIdentity(dir)
    const target = await startTarget('plain')
    const restored = restore(dir, firstSet, target)
    assert.match(restored, /"event":"restored"/)
    const after = parseCounts(psqlIn(target, COUNTS))
    t.diagnostic(`rows per schema: ${JSON.stringify(perSchema(after))}`)
    assert.deepEqual(after, before)
  },
)

test('the restored audit chains verify', { timeout: 10 * 60_000 }, () => {
  const target = `${PROJECT}-target-plain`
  prepareTarget(target)
  assert.deepEqual(verifyChains(target), { ok: true, chains: 2, findings: 0 })
})

test(
  'a backup taken while 50 audit writes run restores to a chain that verifies',
  { timeout: 15 * 60_000 },
  async (t) => {
    const dir = backupDir('concurrent')
    const auditBefore = Number(psql('select count(*) from audit.log'))
    // 50 writes on two chains, two at a time with a pause: several seconds of writing around the backup.
    const writer = spawn(
      'docker',
      [
        'compose',
        '-p',
        PROJECT,
        '-f',
        composeFile,
        '--profile',
        'ops',
        'run',
        '--rm',
        '-T',
        ...['CHAINS', 'WRITES', 'LANES', 'PAUSE_MS'].flatMap((k) => ['-e', k]),
        'core',
        'node',
        '--input-type=module',
        '-',
      ],
      {
        env: {
          ...process.env,
          MKT_SECRETS: secretsDir,
          ...TEST_EGRESS,
          CHAINS: JSON.stringify([brandId, null]),
          WRITES: '50',
          LANES: '2',
          PAUSE_MS: '250',
        },
      },
    )
    let out = ''
    let err = ''
    writer.stdout.on('data', (d) => (out += d))
    writer.stderr.on('data', (d) => (err += d))
    const exited = new Promise((resolve) => writer.on('close', resolve))
    writer.stdin.end(AUDIT_WRITES)
    const end = Date.now() + 300_000
    while (!out.includes('first')) {
      if (Date.now() > end || writer.exitCode !== null)
        throw new Error(`the writer did not start:\n${redact(err)}`)
      await sleep(100)
    }

    const backupStart = Date.now()
    const backup = spawn(
      'docker',
      ['compose', '-p', PROJECT, '-f', composeFile, '--profile', 'ops', 'run', '--rm', '-T', 'backup'],
      { env: { ...process.env, MKT_SECRETS: secretsDir, ...TEST_EGRESS, MKT_BACKUP_DIR: dir } },
    )
    let backupOut = ''
    backup.stdout.on('data', (d) => (backupOut += d))
    backup.stderr.on('data', (d) => (backupOut += d))
    const backupCode = await new Promise((resolve) => backup.on('close', resolve))
    const backupEnd = Date.now()
    assert.equal(backupCode, 0, redact(backupOut))

    assert.equal(await exited, 0, redact(err))
    const writes = lastJson(out)
    assert.equal(writes.n, 50)
    // The backup ran while the entries were being written.
    assert.ok(
      writes.first < backupEnd && writes.last > backupStart,
      `no overlap: writes ${writes.first}..${writes.last}, backup ${backupStart}..${backupEnd}`,
    )

    const [set] = sets(dir)
    putIdentity(dir)
    const target = await startTarget('concurrent')
    restore(dir, set, target)
    const restoredAudit = Number(psqlIn(target, 'select count(*) from audit.log'))
    t.diagnostic(
      `audit entries: ${auditBefore} before, ${restoredAudit} in the backup, ${auditBefore + 50} after`,
    )
    assert.ok(restoredAudit >= auditBefore && restoredAudit <= auditBefore + 50)
    prepareTarget(target)
    assert.deepEqual(verifyChains(target), { ok: true, chains: 2, findings: 0 })
  },
)

test('backup.sh exits non-zero when the target folder is read-only', { timeout: 10 * 60_000 }, () => {
  const dir = backupDir('readonly')
  inBackup(dir, 'chmod 0500 /backups')
  const result = runBackup(dir, {}, false)
  assert.notEqual(result.status, 0, output(result))
  assert.match(output(result), /"event":"backup_failed"/)
  inBackup(dir, 'chmod 0700 /backups')
  assert.deepEqual(listing(dir), [])
})

test('restore.sh refuses a database that already has app tables', { timeout: 10 * 60_000 }, () => {
  const before = psql(COUNTS)
  // The stack's own database, which has every table.
  const result = restore(`${HOST_BASE}/main`, firstSet, 'postgres', false)
  assert.notEqual(result.status, 0, output(result))
  assert.match(output(result), /"event":"restore_refused"/)
  assert.equal(psql(COUNTS), before)
})

test('restore.sh refuses a target address that carries a password', { timeout: 5 * 60_000 }, () => {
  const result = compose(
    [
      'run',
      '--rm',
      '-T',
      '--no-deps',
      '-e',
      'AGE_IDENTITY_FILE=/backups/.test-identity',
      '--entrypoint',
      'mkt-restore',
      'backup',
      `/backups/${firstSet}.dump.age`,
      `/backups/${firstSet}.roles.sql.age`,
      'postgres://postgres:not-a-real-password@nowhere.invalid:5432/mkt',
    ],
    { env: { MKT_BACKUP_DIR: `${HOST_BASE}/main` }, check: false },
  )
  assert.notEqual(result.status, 0)
  assert.match(output(result), /"event":"restore_refused"/)
  assert.doesNotMatch(output(result), /not-a-real-password/)
})

test('the backup files are not readable without the identity', { timeout: 5 * 60_000 }, () => {
  const dir = `${HOST_BASE}/main`
  const wrong = keyPair()
  putIdentity(dir, '.wrong-identity', wrong.key)
  for (const file of [`${firstSet}.dump.age`, `${firstSet}.roles.sql.age`]) {
    // Encrypted: an age file, with neither the dump's nor the SQL's plain text in it.
    assert.equal(inBackup(dir, `head -c 21 /backups/${file}`), 'age-encryption.org/v1')
    assert.equal(
      inBackup(dir, `grep -c -a -e PGDMP -e 'CREATE ROLE' /backups/${file} || true`).trim(),
      '0',
      file,
    )
    const denied = inBackup(dir, `age -d -i /backups/.wrong-identity -o /dev/null /backups/${file}`, {
      check: false,
    })
    assert.notEqual(denied.status, 0, file)
    // The right identity opens it.
    inBackup(dir, `age -d -i /backups/.test-identity -o /dev/null /backups/${file}`)
  }
  assert.equal(
    inBackup(dir, `age -d -i /backups/.test-identity /backups/${firstSet}.dump.age | head -c 5`),
    'PGDMP',
  )
})

test('on the server the newest 7 backups are kept', { timeout: 10 * 60_000 }, () => {
  const dir = backupDir('retention')
  // Nine older sets (fake, but named as backup.sh names them) and a file that is not a backup.
  const old = Array.from({ length: 9 }, (_, i) => `mkt-2020010${i + 1}T213000Z`)
  inBackup(
    dir,
    `cd /backups && for s in ${old.join(' ')}; do for f in dump.age dump.age.sha256 roles.sql.age roles.sql.age.sha256; do echo x > "$s.$f"; done; done; echo keep > notes.txt`,
  )
  runBackup(dir)
  const kept = sets(dir)
  assert.equal(kept.length, 7)
  assert.deepEqual(kept.slice(0, 6), old.slice(3))
  assert.ok(kept[6] > old[8])
  // Every kept set is whole; the removed ones are gone entirely; other files are untouched.
  const files = listing(dir)
  assert.equal(files.filter((f) => f.startsWith('mkt-')).length, 28)
  assert.ok(files.includes('notes.txt'))
})

test(
  'the offsite service copies the newest complete set to daily/ and, once a month, to monthly/',
  { timeout: 10 * 60_000 },
  () => {
    const dir = backupDir('offsite')
    const remote = `${HOST_BASE}/remote`
    // No complete set yet: the run fails, it never copies nothing and calls it a success.
    const empty = runOffsite(dir, remote, { RCLONE_REMOTE: '/remote/mkt' }, false)
    assert.notEqual(empty.status, 0, output(empty))
    assert.match(output(empty), /"event":"offsite_failed","step":"find_set"/)
    runBackup(dir)
    // An older set and a half-written newer one (no checksum): the newest complete set is the real one.
    inBackup(
      dir,
      'cd /backups && for f in dump.age dump.age.sha256 roles.sql.age roles.sql.age.sha256; do echo x > mkt-20200101T213000Z.$f; done; echo x > mkt-29990101T000000Z.dump.age',
    )
    const [, set] = sets(dir)
    const files = [
      `${set}.dump.age`,
      `${set}.dump.age.sha256`,
      `${set}.roles.sql.age`,
      `${set}.roles.sql.age.sha256`,
    ]
    const remoteList = (sub) =>
      inBackup(remote, `ls -1 /backups/mkt/${sub} 2>/dev/null || true`)
        .trim()
        .split('\n')
        .filter(Boolean)
        .sort()

    const first = lastJson(runOffsite(dir, remote, { RCLONE_REMOTE: '/remote/mkt' }))
    assert.deepEqual(first, { event: 'offsite_copied', name: set, monthly: true })
    assert.deepEqual(remoteList('daily'), files)
    assert.deepEqual(remoteList('monthly'), files)
    // Again in the same month: daily again (unchanged files are left as they are), no second monthly copy.
    const second = lastJson(runOffsite(dir, remote, { RCLONE_REMOTE: '/remote/mkt' }))
    assert.deepEqual(second, { event: 'offsite_copied', name: set, monthly: false })
    assert.deepEqual(remoteList('monthly'), files)

    // Unset: skipped, and says so.
    assert.match(runOffsite(dir, remote), /"event":"offsite_skipped"/)
    // A remote that does not exist: the run fails, naming the step.
    const failed = runOffsite(dir, remote, { RCLONE_REMOTE: 'nosuchremote:mkt-backups/mkt' }, false)
    assert.notEqual(failed.status, 0, output(failed))
    assert.match(output(failed), /"event":"offsite_failed","step":"daily"/)
  },
)

test(
  'a monthly set left partial by a failed run is completed by the next run, not skipped',
  { timeout: 10 * 60_000 },
  () => {
    const dir = backupDir('offsite-partial')
    const remote = `${HOST_BASE}/remote-partial`
    runBackup(dir)
    const [set] = sets(dir)
    const files = [
      `${set}.dump.age`,
      `${set}.dump.age.sha256`,
      `${set}.roles.sql.age`,
      `${set}.roles.sql.age.sha256`,
    ]
    const env = { RCLONE_REMOTE: '/remote/mkt' }
    runOffsite(dir, remote, env)
    const monthly = (cmd) => inBackup(remote, `cd /backups/mkt/monthly && ${cmd}`)
    // The state a run that failed after the dump was copied leaves: the dump (and its checksum), no roles file.
    monthly(`rm -f ${set}.roles.sql.age ${set}.roles.sql.age.sha256`)
    assert.deepEqual(monthly('ls -1').trim().split('\n').sort(), files.slice(0, 2))
    const again = lastJson(runOffsite(dir, remote, env))
    assert.deepEqual(again, { event: 'offsite_copied', name: set, monthly: true })
    assert.deepEqual(monthly('ls -1').trim().split('\n').sort(), files)
    // A complete set is left alone.
    assert.deepEqual(lastJson(runOffsite(dir, remote, env)), {
      event: 'offsite_copied',
      name: set,
      monthly: false,
    })
  },
)

test(
  'a monthly listing that fails for a reason other than a missing folder fails the step, not "no set yet"',
  { timeout: 10 * 60_000 },
  () => {
    const dir = backupDir('offsite-lsf')
    const remote = `${HOST_BASE}/remote-lsf`
    runBackup(dir)
    const env = { RCLONE_REMOTE: '/remote/mkt' }
    runOffsite(dir, remote, env)
    // A listing that fails with exit 1 (a stand-in rclone ahead of the real one on PATH; everything but `lsf`
    // goes to the real binary). Treated as "no set yet" it would add a second monthly set; it must fail the step.
    inBackup(
      remote,
      `printf '%s\\n' '#!/bin/sh' 'if [ "$1" = lsf ]; then exit 1; fi' 'exec /usr/local/bin/rclone "$@"' > /backups/rclone-stub && chmod 755 /backups/rclone-stub`,
    )
    const failed = runOffsite(dir, remote, env, false, [`${remote}/rclone-stub:/usr/local/sbin/rclone:ro`])
    assert.notEqual(failed.status, 0, output(failed))
    assert.match(output(failed), /"event":"offsite_failed","step":"monthly","code":1/)
    // The same stand-in with a first run on an empty prefix is not needed: exit 3 (no folder) is the first-run
    // path, covered by the test above.
  },
)

test('the offsite service cannot write the backups or reach the database, and holds no database secret', () => {
  const dir = `${HOST_BASE}/offsite`
  const probe = compose(
    [
      'run',
      '--rm',
      '-T',
      '--no-deps',
      '--entrypoint',
      'sh',
      'offsite',
      '-c',
      'touch /backups/x 2>/dev/null && echo writable; env | grep -c -e ADMIN_DATABASE_URL -e POSTGRES_PASSWORD || true; getent hosts postgres >/dev/null && echo resolves || true',
    ],
    { env: { MKT_BACKUP_DIR: dir } },
  )
  assert.equal(probe.trim(), '0')
})

test('a malformed ADMIN_DATABASE_URL fails the backup without its password reaching the log', () => {
  const dir = backupDir('badurl')
  const password = `pw-${randomBytes(8).toString('hex')}`
  for (const url of [
    `postgres://postgres:${password}@[not-a-host:5432/mkt`,
    `postgres://postgres:${password}@/mkt`,
  ]) {
    const result = runBackup(dir, { ADMIN_DATABASE_URL: url }, false)
    assert.notEqual(result.status, 0)
    const all = `${result.stdout ?? ''}${result.stderr ?? ''}`
    assert.ok(!all.includes(password), 'the password was printed')
    assert.match(
      all,
      /"event":"backup_refused","reason":"ADMIN_DATABASE_URL is not a valid postgres:\/\/ address with a host, user and database"/,
    )
  }
  assert.deepEqual(listing(dir), [])
})

test('ops alert raises one severity 1 platform alert for a failed backup', { timeout: 5 * 60_000 }, () => {
  const first = lastJson(compose(['run', '--rm', '-T', 'ops', 'alert', 'backup_failed']))
  assert.deepEqual(first, { event: 'alert_raised', kind: 'backup_failed', created: true })
  assert.equal(
    psql(`select severity || ' ' || coalesce(brand_id::text, 'platform') || ' ' || (delivered_at is null)
            from app.alert where kind = 'backup_failed'`),
    '1 platform true',
  )
  // Again while it is open: nothing new.
  assert.equal(lastJson(compose(['run', '--rm', '-T', 'ops', 'alert', 'backup_failed'])).created, false)
  const unknown = compose(['run', '--rm', '-T', 'ops', 'alert', 'something_else'], { check: false })
  assert.notEqual(unknown.status, 0)
})

// The host units (installed by the runbook, docs/operations.md "Backups").
test('the timer runs the backup daily at 21:00 UTC (02:30 IST); a failure runs the alert', () => {
  const unit = (name) => readFileSync(join(root, 'infra/prod/backup', name), 'utf8')
  const timer = unit('mkt-backup.timer')
  assert.match(timer, /^OnCalendar=\*-\*-\* 21:00:00 UTC$/m)
  assert.match(timer, /^Persistent=true$/m)
  assert.match(timer, /^Unit=mkt-backup\.service$/m)
  const service = unit('mkt-backup.service')
  assert.match(service, /^OnFailure=mkt-backup-alert\.service$/m)
  assert.match(service, /^Type=oneshot$/m)
  const run =
    '/usr/bin/docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml --profile ops run --rm -T'
  const execStart = (text) => [...text.matchAll(/^ExecStart=(.*)$/gm)].map((m) => m[1])
  // The backup, then (only if it succeeded) the off-server copy; either failing fails the unit.
  assert.deepEqual(execStart(service), [`${run} backup`, `${run} offsite`])
  const alert = unit('mkt-backup-alert.service')
  assert.deepEqual(execStart(alert), [`${run} ops alert backup_failed`])
  for (const text of [service, alert]) assert.match(text, /^WorkingDirectory=\/opt\/mkt\/marketing$/m)
})
