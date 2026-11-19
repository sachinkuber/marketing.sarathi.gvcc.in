// The proxy site template (infra/prod/proxy/marketing.caddy, plan M7 Task 7), rendered and run in the same Caddy
// as the servers' (2.10.2, pinned by digest) in front of the stand-in core and dashboard (fixtures/fake-origin):
// Caddy accepts it, the smoke script passes through it, X-Forwarded-For is replaced (never appended), and the
// path, query, headers and bodies reach the core unchanged.
// Two Caddy containers share the host network, listening on 127.0.0.1 only: "direct" trusts Cloudflare's ranges
// alone, so the test's requests come from an untrusted peer, as a request sent around Cloudflare would;
// "via-cloudflare" also trusts 127.0.0.1, so the test's requests stand for Cloudflare's.
// Needs Docker (host networking). It fails, never skips, without it. On the development server it runs through
// /opt/mkt-dev/server-run-infra.sh; in CI in the e2e job.
//   node --test infra/prod/test/proxy.test.mjs
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { startFakeOrigin } from './fixtures/fake-origin.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const smoke = join(root, 'infra/prod/smoke.mjs')
// caddy:2.10-alpine (Caddy 2.10.2), the proxy the servers run.
const CADDY = 'caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
const PREFIX = 'mkt-m7test-proxy'
const NAMES = ['direct', 'via-cloudflare']
const triggerSecret = randomBytes(32).toString('hex')
const proxies = {}
let core
let dashboard
let dir
let secretFile

const cloudflareRanges = () =>
  readFileSync(join(root, 'infra/prod/proxy/cloudflare-ips.txt'), 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)

// The template with every placeholder replaced; a placeholder left over is an error.
function renderSite(values) {
  let text = readFileSync(join(root, 'infra/prod/proxy/marketing.caddy'), 'utf8')
  for (const [name, value] of Object.entries(values)) text = text.split(`__MKT_${name}__`).join(value)
  const left = text.match(/__MKT_[A-Z_]+__/)
  if (left) throw new Error(`placeholder ${left[0]} was not replaced`)
  return text
}

// The global options docs/operations.md asks for, plus what a test on a shared host needs (loopback only, no
// admin endpoint, no certificates).
function caddyfile(port, trusted) {
  return `{
	admin off
	auto_https off
	default_bind 127.0.0.1
	servers {
		trusted_proxies static ${trusted.join(' ')}
		client_ip_headers CF-Connecting-IP
	}
}

${renderSite({
  // Any host name on this port: the test connects to 127.0.0.1, with that as Host.
  HOST: `http://:${port}`,
  TLS: '',
  CORE: `127.0.0.1:${core?.port ?? 4100}`,
  DASHBOARD: `127.0.0.1:${dashboard?.port ?? 3100}`,
})}`
}

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error(
      `docker ${args[0]} failed (${result.status ?? result.error}):\n${result.stdout}${result.stderr}`,
    )
  }
  return result.stdout
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The Caddyfile reaches the container in its environment, not a bind mount: this test may itself run in a
// container that talks to the host's Docker, where a path of ours means nothing.
const inContainer = (command) => ['sh', '-c', `printf '%s' "$CADDYFILE" > /tmp/Caddyfile && ${command}`]

async function startProxy(name, port, trusted) {
  docker(
    [
      'run',
      '-d',
      '--rm',
      '--name',
      `${PREFIX}-${name}`,
      '--network',
      'host',
      '--memory',
      '128m',
      '--cpus',
      '0.5',
      '-e',
      'CADDYFILE',
      CADDY,
      ...inContainer('exec caddy run --config /tmp/Caddyfile --adapter caddyfile'),
    ],
    { env: { ...process.env, CADDYFILE: caddyfile(port, trusted) } },
  )
  const proxy = { port, origin: `http://proxy.example.test:${port}`, url: `http://127.0.0.1:${port}` }
  for (let i = 0; ; i++) {
    const up = await fetch(`${proxy.url}/api/health/ready`, { signal: AbortSignal.timeout(2000) }).then(
      (r) => r.status === 200,
      () => false,
    )
    if (up) return proxy
    if (i === 60) {
      const logs = spawnSync('docker', ['logs', `${PREFIX}-${name}`], { encoding: 'utf8' })
      throw new Error(`caddy ${name} did not start:\n${logs.stdout}${logs.stderr}`)
    }
    await sleep(500)
  }
}

function removeProxies() {
  for (const name of NAMES) spawnSync('docker', ['rm', '-f', `${PREFIX}-${name}`], { encoding: 'utf8' })
}

before(async () => {
  if (spawnSync('docker', ['version', '--format', '{{.Server.Version}}']).status !== 0) {
    throw new Error('docker is not available. These tests need it and never skip.')
  }
  removeProxies()
  dir = mkdtempSync(join(tmpdir(), 'mkt-proxy-'))
  chmodSync(dir, 0o700)
  secretFile = join(dir, 'trigger-secret')
  writeFileSync(secretFile, triggerSecret, { mode: 0o600 })
  const ports = { direct: await freePort(), viaCloudflare: await freePort() }
  const origins = Object.values(ports).map((port) => `http://proxy.example.test:${port}`)
  core = await startFakeOrigin({ role: 'core', clientAddress: 'core', triggerSecret, origin: origins })
  dashboard = await startFakeOrigin({ role: 'dashboard', origin: origins })
  proxies.direct = await startProxy('direct', ports.direct, cloudflareRanges())
  proxies.viaCloudflare = await startProxy('via-cloudflare', ports.viaCloudflare, [
    ...cloudflareRanges(),
    '127.0.0.1/32',
  ])
})

after(async () => {
  removeProxies()
  await core?.close()
  await dashboard?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

// What the core received for a request to /api/echo/... (or the dashboard, for /echo/...).
async function echo(proxy, path, init = {}) {
  const response = await fetch(`${proxy.url}${path}`, { ...init, signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200, `${path}: ${response.status}`)
  return response.json()
}

function runSmoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smoke, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out }))
  })
}

test('the rendered template is accepted by caddy validate', () => {
  const out = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-e',
      'CADDYFILE',
      CADDY,
      ...inContainer('caddy validate --config /tmp/Caddyfile --adapter caddyfile'),
    ],
    { encoding: 'utf8', env: { ...process.env, CADDYFILE: caddyfile(18080, cloudflareRanges()) } },
  )
  assert.equal(out.status, 0, `${out.stdout}${out.stderr}`)
  assert.match(out.stdout + out.stderr, /Valid configuration/)
  assert.throws(() => renderSite({ HOST: 'x' }), /placeholder __MKT_TLS__ was not replaced/)
})

test('the Cloudflare ranges file is dated and holds address ranges only', () => {
  const text = readFileSync(join(root, 'infra/prod/proxy/cloudflare-ips.txt'), 'utf8')
  assert.match(text, /Fetched \d{4}-\d{2}-\d{2} from https:\/\/www\.cloudflare\.com\/ips-v4/)
  const ranges = cloudflareRanges()
  assert.ok(ranges.length >= 10)
  for (const range of ranges) assert.match(range, /^([0-9.]+\/\d{1,2}|[0-9a-f:]+\/\d{1,3})$/, range)
})

test('the smoke script passes every check through the proxy, forged headers sent directly', async () => {
  const proxy = proxies.direct
  const { code, out } = await runSmoke([
    proxy.origin,
    '--connect',
    proxy.url,
    '--direct',
    proxy.url,
    '--trigger-secret-file',
    secretFile,
  ])
  assert.equal(code, 0, out)
  assert.ok(!out.includes(triggerSecret))
})

test('sent directly, forged CF-Connecting-IP and X-Forwarded-For are dropped: the core sees the peer', async () => {
  const seen = await echo(proxies.direct, '/api/echo/address', {
    headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.7, 198.51.100.8' },
  })
  assert.equal(seen.headers['x-forwarded-for'], '127.0.0.1')
})

test('from Cloudflare, X-Forwarded-For is replaced by CF-Connecting-IP, never appended to', async () => {
  const seen = await echo(proxies.viaCloudflare, '/api/echo/address', {
    headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.7' },
  })
  assert.equal(seen.headers['x-forwarded-for'], '203.0.113.9')
  // The dashboard gets the same.
  const page = await echo(proxies.viaCloudflare, '/echo/address', {
    headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.7' },
  })
  assert.equal(page.role, 'dashboard')
  assert.equal(page.headers['x-forwarded-for'], '203.0.113.9')
  // X-Forwarded-For alone is not believed even from Cloudflare (only CF-Connecting-IP is read).
  const xffOnly = await echo(proxies.viaCloudflare, '/api/echo/address', {
    headers: { 'x-forwarded-for': '198.51.100.7' },
  })
  assert.equal(xffOnly.headers['x-forwarded-for'], '127.0.0.1')
})

test('/api/ goes to the core and everything else, /api included, to the dashboard', async () => {
  assert.equal((await echo(proxies.direct, '/api/echo/x')).role, 'core')
  assert.equal((await echo(proxies.direct, '/echo/x')).role, 'dashboard')
  const bare = await fetch(`${proxies.direct.url}/api`, { signal: AbortSignal.timeout(10_000) })
  assert.match(bare.headers.get('content-type') ?? '', /text\/html/)
})

test('path, query, Host, Authorization, the X-Mkt-* headers and the raw body reach the core unchanged', async () => {
  const body = randomBytes(4096)
  const headers = {
    authorization: 'Worker abc',
    'x-mkt-timestamp': '1700000000',
    'x-mkt-nonce': 'a'.repeat(64),
    'x-mkt-signature': 'b'.repeat(64),
    'content-type': 'application/octet-stream',
    // Not decoded by the proxy: the signature covers the bytes on the wire.
    'content-encoding': 'gzip',
  }
  const path = '/api/echo/v1/triggers/ping?b=2&a=%20x&a=1'
  const seen = await echo(proxies.viaCloudflare, path, { method: 'POST', headers, body })
  assert.equal(seen.url, path)
  assert.equal(seen.headers.host, `127.0.0.1:${proxies.viaCloudflare.port}`)
  for (const [name, value] of Object.entries(headers)) assert.equal(seen.headers[name], value, name)
  assert.equal(seen.bodyLength, body.length)
  assert.equal(seen.bodySha256, createHash('sha256').update(body).digest('hex'))
})

test('a DELETE body reaches the core', async () => {
  const body = JSON.stringify({ code: '123456' })
  const seen = await echo(proxies.direct, '/api/echo/brands/x/users/y', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body,
  })
  assert.equal(seen.method, 'DELETE')
  assert.equal(seen.bodyLength, body.length)
})

test('a body up to 1 MiB reaches the core; a larger one is refused by the proxy (413)', async () => {
  const ok = await echo(proxies.direct, '/api/echo/big', { method: 'POST', body: Buffer.alloc(1024 * 1024) })
  assert.equal(ok.bodyLength, 1024 * 1024)
  const before = core.seen.length
  const big = await fetch(`${proxies.direct.url}/api/echo/bigger`, {
    method: 'POST',
    body: Buffer.alloc(1024 * 1024 + 1024),
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(big.status, 413)
  assert.ok(!core.seen.slice(before).some((r) => r.url === '/api/echo/bigger' && r.bodyLength > 1024 * 1024))
})

test('every response carries HSTS and COOP once, and no Server header', async () => {
  for (const path of ['/', '/api/health/ready']) {
    const response = await fetch(`${proxies.direct.url}${path}`, { signal: AbortSignal.timeout(10_000) })
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000', path)
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin', path)
    assert.equal(response.headers.get('server'), null, path)
  }
})
