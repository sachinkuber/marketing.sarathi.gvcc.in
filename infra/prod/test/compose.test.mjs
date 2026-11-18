// The production compose file (plan, Task 5): limits, networks, ports, grace period, health checks and secrets,
// read from `docker compose config` with the example env files in place of /opt/mkt/secrets.
// Needs the Docker CLI with the Compose plugin (no daemon). It fails, never skips, when either is missing. On the
// development server it runs through /opt/mkt-dev/server-run-infra.sh; in CI in the e2e job.
//   node --test infra/prod/test/compose.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const composeFile = join(root, 'infra/prod/compose.yaml')
const examples = join(root, 'infra/prod/secrets.example')
const ENV_FILES = ['postgres', 'roles', 'core', 'worker', 'dashboard']
const PRODUCT = ['postgres', 'core', 'worker', 'dashboard']
const GiB = 1024 ** 3
let secretsDir

function compose(args, env = {}) {
  const result = spawnSync('docker', ['compose', '-f', composeFile, ...args], {
    encoding: 'utf8',
    // The egress variables unset (empty), so the file's own defaults are what is tested.
    env: { ...process.env, MKT_SECRETS: secretsDir, MKT_EGRESS_BRIDGE: '', MKT_EGRESS_SUBNET: '', ...env },
  })
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(' ')} failed (${result.status ?? result.error}):\n${result.stderr}`,
    )
  }
  return result.stdout
}

// The model with the env files' contents left out of `environment` (only what the compose file itself sets).
const config = (profiles = []) =>
  JSON.parse(
    compose([
      ...profiles.flatMap((p) => ['--profile', p]),
      'config',
      '--format',
      'json',
      '--no-env-resolution',
    ]),
  )

before(() => {
  const version = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' })
  if (version.status !== 0)
    throw new Error('docker compose is not available. These tests need it and never skip.')
  // The example files stand in for /opt/mkt/secrets, under the names the compose file reads.
  secretsDir = mkdtempSync(join(tmpdir(), 'mkt-compose-'))
  chmodSync(secretsDir, 0o700)
  for (const name of ENV_FILES) {
    copyFileSync(join(examples, `${name}.env.example`), join(secretsDir, `${name}.env`))
  }
})

after(() => {
  if (secretsDir) rmSync(secretsDir, { recursive: true, force: true })
})

// Compose writes durations as Go does (1m30s, 45s, 500ms).
function seconds(duration) {
  const units = { h: 3600, m: 60, s: 1, ms: 0.001 }
  let total = 0
  for (const [, n, unit] of String(duration).matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g))
    total += Number(n) * units[unit]
  return total
}

function limits(service) {
  const l = service.deploy?.resources?.limits ?? {}
  return { cpus: Number(l.cpus ?? service.cpus), memory: Number(l.memory ?? service.mem_limit) }
}

const healthText = (service) => [service.healthcheck?.test ?? []].flat().join(' ')

test('the compose file loads with the example env files', () => {
  const resolved = JSON.parse(compose(['--profile', 'ops', 'config', '--format', 'json']))
  assert.equal(resolved.name, 'mkt')
  assert.deepEqual(Object.keys(resolved.services).sort(), ['core', 'dashboard', 'ops', 'postgres', 'worker'])
  assert.deepEqual(resolved.services.ops.profiles, ['ops'])
  // The database lives in the volume mkt_pg (project mkt, volume pg).
  assert.equal(resolved.volumes.pg.name, 'mkt_pg')
  assert.ok(resolved.services.postgres.volumes.some((v) => v.type === 'volume' && v.source === 'pg'))
})

test('every image is a local target or pinned by digest', () => {
  const stages = new Set(
    [
      ...readFileSync(join(root, 'infra/prod/Dockerfile'), 'utf8').matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim),
    ].map(([, stage]) => stage),
  )
  for (const [name, service] of Object.entries(config(['ops']).services)) {
    if (service.build) {
      assert.equal(service.build.dockerfile, 'infra/prod/Dockerfile', name)
      assert.equal(service.build.context, root.replace(/\/$/, ''), name)
      assert.ok(stages.has(service.build.target), `${name}: target ${service.build.target}`)
      // A built service never pulls: a tag of the same name on a registry cannot replace it.
      assert.equal(service.image, undefined, `${name} names an image as well as a build`)
    } else {
      assert.match(service.image ?? '', /^[a-z0-9./_-]+(:[\w.-]+)?@sha256:[0-9a-f]{64}$/, name)
    }
  }
})

test('the sum of cpus is at most 2.0 and the sum of memory at most 4 GiB', () => {
  const services = config().services
  // Only the product services: ops is a profile, out of the default config.
  assert.deepEqual(Object.keys(services).sort(), [...PRODUCT].sort())
  let cpus = 0
  let memory = 0
  for (const [name, service] of Object.entries(services)) {
    const l = limits(service)
    assert.ok(l.cpus > 0, `${name} has no processor limit`)
    assert.ok(l.memory > 0, `${name} has no memory limit`)
    cpus += l.cpus
    memory += l.memory
  }
  assert.ok(cpus <= 2.0 + 1e-9, `cpus ${cpus}`)
  assert.ok(memory <= 4 * GiB, `memory ${memory / GiB} GiB`)
})

test('postgres publishes no port and is only on data', () => {
  const postgres = config().services.postgres
  assert.deepEqual(postgres.ports ?? [], [])
  assert.deepEqual(postgres.expose ?? [], [])
  assert.deepEqual(Object.keys(postgres.networks ?? {}), ['data'])
})

test('worker and data are internal', () => {
  const { networks } = config(['ops'])
  assert.equal(networks.worker?.internal, true)
  assert.equal(networks.data?.internal, true)
  // Scoped to the project (mkt_app, mkt_worker...), never an external network such as the proxy's.
  for (const [key, network] of Object.entries(networks)) {
    assert.notEqual(network.external, true, key)
    assert.equal(network.name, `mkt_${key}`, key)
  }
})

test('the worker is not on app', () => {
  const services = config(['ops']).services
  const worker = Object.keys(services.worker.networks ?? {})
  assert.ok(!worker.includes('app'))
  // Its only way out is its own egress network, with nothing else on it. That network is not restricted here
  // (any outbound address); the host firewall limits it to the model provider (Task 7).
  assert.deepEqual(worker.sort(), ['data', 'worker', 'worker_egress'])
  for (const [name, service] of Object.entries(services)) {
    if (name !== 'worker') assert.ok(!Object.keys(service.networks ?? {}).includes('worker_egress'), name)
  }
  assert.deepEqual(Object.keys(services.core.networks).sort(), ['app', 'data', 'worker'])
  assert.deepEqual(Object.keys(services.dashboard.networks), ['app'])
  assert.deepEqual(Object.keys(services.ops.networks), ['data'])
})

test('published ports bind 127.0.0.1 only', () => {
  const published = []
  for (const [name, service] of Object.entries(config(['ops']).services)) {
    for (const port of service.ports ?? []) {
      assert.equal(
        port.host_ip,
        '127.0.0.1',
        `${name} publishes ${port.published} on ${port.host_ip ?? 'all'}`,
      )
      published.push(`${name} ${port.host_ip}:${port.published}:${port.target}`)
    }
  }
  assert.deepEqual(published.sort(), ['core 127.0.0.1:4100:4000', 'dashboard 127.0.0.1:3100:3000'])
})

// The host firewall (infra/prod/firewall/mkt-egress.sh) keys on the egress bridge's name, installed before the
// stack starts; the subnet is fixed and IPv6 is off (the rules are IPv4 only).
test('worker_egress has a fixed bridge name, the firewall script uses it, a fixed subnet, and no IPv6', () => {
  const egress = config().networks.worker_egress
  assert.equal(egress.driver, 'bridge')
  assert.equal(egress.enable_ipv6, false)
  assert.equal(egress.driver_opts?.['com.docker.network.bridge.name'], 'mkt-egress0')
  assert.ok('mkt-egress0'.length <= 15)
  assert.deepEqual(
    egress.ipam?.config?.map((c) => c.subnet),
    ['10.247.73.0/24'],
  )
  // The firewall script reads the same variable with the same default.
  const script = readFileSync(join(root, 'infra/prod/firewall/mkt-egress.sh'), 'utf8')
  assert.match(script, /^BRIDGE=\$\{MKT_EGRESS_BRIDGE:-mkt-egress0\}$/m)
  const raw = readFileSync(composeFile, 'utf8')
  assert.match(raw, /com\.docker\.network\.bridge\.name: \$\{MKT_EGRESS_BRIDGE:-mkt-egress0\}$/m)
  // Overridden, as the test stack does.
  const other = JSON.parse(
    compose(['config', '--format', 'json'], {
      MKT_EGRESS_BRIDGE: 'mkt-m7t-egress0',
      MKT_EGRESS_SUBNET: '10.247.74.0/24',
    }),
  ).networks.worker_egress
  assert.equal(other.driver_opts['com.docker.network.bridge.name'], 'mkt-m7t-egress0')
  assert.deepEqual(
    other.ipam.config.map((c) => c.subnet),
    ['10.247.74.0/24'],
  )
})

// infra/prod/compose.proxy-network.yaml, for a proxy that runs in Docker (Task 7). The base file's own tests above
// stay as they are; this override only adds the core and the dashboard to the proxy's external network.
test('the proxy-network override adds only core and dashboard to the named external network', () => {
  const overrideFile = join(root, 'infra/prod/compose.proxy-network.yaml')
  const withOverride = (env) =>
    spawnSync(
      'docker',
      ['compose', '-f', composeFile, '-f', overrideFile, '--profile', 'ops', 'config', '--format', 'json'],
      { encoding: 'utf8', env: { ...process.env, MKT_SECRETS: secretsDir, ...env } },
    )
  // Refused without the network's name.
  const unnamed = withOverride({ MKT_PROXY_NETWORK: '' })
  assert.notEqual(unnamed.status, 0)
  assert.match(unnamed.stderr, /MKT_PROXY_NETWORK/)
  const result = withOverride({ MKT_PROXY_NETWORK: 'web' })
  assert.equal(result.status, 0, result.stderr)
  const { services, networks } = JSON.parse(result.stdout)
  assert.equal(networks.proxy.name, 'web')
  assert.equal(networks.proxy.external, true)
  assert.deepEqual(Object.keys(services.core.networks).sort(), ['app', 'data', 'proxy', 'worker'])
  assert.deepEqual(Object.keys(services.dashboard.networks).sort(), ['app', 'proxy'])
  assert.deepEqual(services.core.networks.proxy.aliases, ['mkt-core'])
  assert.deepEqual(services.dashboard.networks.proxy.aliases, ['mkt-dashboard'])
  for (const name of ['postgres', 'worker', 'ops']) {
    assert.ok(!Object.keys(services[name].networks ?? {}).includes('proxy'), name)
  }
  // Everything else is the base file's: the project's own networks stay internal and scoped, ports on 127.0.0.1.
  assert.equal(networks.worker.internal, true)
  assert.equal(networks.data.internal, true)
  for (const key of ['app', 'worker', 'data', 'worker_egress']) assert.equal(networks[key].name, `mkt_${key}`)
  assert.deepEqual(
    Object.values(services).flatMap((s) => (s.ports ?? []).map((p) => p.host_ip)),
    ['127.0.0.1', '127.0.0.1'],
  )
})

test('worker stop_grace_period is at least 45s', () => {
  assert.ok(seconds(config().services.worker.stop_grace_period) >= 45)
})

test('every service has restart: unless-stopped and a healthcheck', () => {
  const services = config().services
  for (const name of PRODUCT) {
    const service = services[name]
    assert.equal(service.restart, 'unless-stopped', name)
    assert.ok(!service.healthcheck?.disable, `${name} has its health check disabled`)
    assert.ok(['CMD', 'CMD-SHELL'].includes(service.healthcheck?.test?.[0]), `${name} has no health check`)
  }
  assert.match(healthText(services.core), /http:\/\/127\.0\.0\.1:4000\/health\/ready\b/)
  assert.match(healthText(services.dashboard), /http:\/\/127\.0\.0\.1:3000\/['"]/)
  assert.match(healthText(services.postgres), /\bpg_isready\b/)
  // The worker serves nothing: its check is that its process (PID 1) is alive.
  assert.match(healthText(services.worker), /process\.kill\(1, 0\)/)
  // Core starts after postgres is healthy, the worker after the core, the dashboard after the core.
  assert.equal(services.core.depends_on?.postgres?.condition, 'service_healthy')
  assert.equal(services.worker.depends_on?.core?.condition, 'service_healthy')
  assert.equal(services.dashboard.depends_on?.core?.condition, 'service_healthy')
})

// Names that hold a secret, and values that look like one (a URL with a password, a long random string).
const SECRET_NAME = /SECRET|PASSWORD|TOKEN|KEY|DSN|DATABASE_URL|SMTP/i
const SECRET_VALUE = /:\/\/[^/\s:@]+:[^@\s]+@|[A-Za-z0-9+/_-]{24,}/

test('no environment value in the file is a literal secret', () => {
  const services = config(['ops']).services
  for (const [name, service] of Object.entries(services)) {
    for (const [key, value] of Object.entries(service.environment ?? {})) {
      assert.doesNotMatch(key, SECRET_NAME, `${name}: ${key} is set in the compose file`)
      assert.doesNotMatch(String(value ?? ''), SECRET_VALUE, `${name}: ${key}`)
    }
    // Every service reads its configuration from env files under /opt/mkt/secrets (MKT_SECRETS here).
    const files = (service.env_file ?? []).map((f) => (typeof f === 'string' ? f : f.path))
    assert.ok(files.length > 0, `${name} has no env_file`)
    for (const file of files) assert.ok(file.startsWith(`${secretsDir}/`), `${name}: ${file}`)
  }
  // The default location, when MKT_SECRETS is not set.
  const defaults = JSON.parse(
    compose(['config', '--format', 'json', '--no-env-resolution', '--no-path-resolution'], {
      MKT_SECRETS: '',
    }),
  )
  for (const [name, service] of Object.entries(defaults.services)) {
    for (const f of service.env_file) assert.match(f.path ?? f, /^\/opt\/mkt\/secrets\/[a-z]+\.env$/, name)
  }
  // The raw file: no secret-named key carries a value, and no value looks like a secret.
  const raw = readFileSync(composeFile, 'utf8')
  for (const line of raw.split('\n')) {
    if (/^\s*#/.test(line)) continue
    assert.doesNotMatch(line, /:\/\/[^/\s:@]+:[^@\s]+@/, line)
    assert.doesNotMatch(line, /^\s*-?\s*[A-Z_]*(SECRET|PASSWORD|TOKEN|_KEY|DSN)[A-Z_]*\s*[:=]\s*\S/, line)
  }
})

test('the example env files hold placeholders only', () => {
  assert.deepEqual(readdirSync(examples).sort(), ENV_FILES.map((n) => `${n}.env.example`).sort())
  for (const name of ENV_FILES) {
    for (const line of readFileSync(join(examples, `${name}.env.example`), 'utf8').split('\n')) {
      if (line.trim() === '' || line.startsWith('#')) continue
      const [, key, value] = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/) ?? []
      assert.ok(key, `${name}.env.example: not KEY=value: ${line}`)
      if (SECRET_NAME.test(key) && value !== '') {
        assert.match(value, /CHANGE_ME/, `${name}.env.example: ${key} is not a placeholder`)
      }
    }
  }
})
