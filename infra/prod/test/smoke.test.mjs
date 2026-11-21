// The smoke script (plan, Task 7 step 2) run against small local stand-ins for the product (fixtures/fake-origin):
// it passes a good origin and fails each broken one, one line per check, without printing a secret.
// Needs only Node (no Docker, no network beyond 127.0.0.1).
//   node --test infra/prod/test/smoke.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { startFakeOrigin } from './fixtures/fake-origin.mjs'

const smoke = fileURLToPath(new URL('../smoke.mjs', import.meta.url))
const ORIGIN = 'https://smoke.example.test'
const CHECKS = [
  'ready',
  'worker',
  'root',
  'session',
  'trigger',
  'forged-invite',
  'forged-sign-in',
  'delete-body',
  'checkpoint-body',
  'document-body',
]
const triggerSecret = randomBytes(32).toString('hex')
let dir
let secretFile

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'mkt-smoke-'))
  chmodSync(dir, 0o700)
  secretFile = join(dir, 'trigger-secret')
  writeFileSync(secretFile, `${triggerSecret}\n`, { mode: 0o600 })
})

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function runSmoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smoke, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

// One line per check: "<PASS|FAIL|SKIP> <name> <detail>".
function results(stdout) {
  const map = new Map()
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(PASS|FAIL|SKIP) +(\S+)/)
    if (match) map.set(match[2], match[1])
  }
  return map
}

async function smokeAgainst(fakeOptions, extraArgs = []) {
  const fake = await startFakeOrigin({ origin: ORIGIN, triggerSecret, ...fakeOptions })
  try {
    const out = await runSmoke([
      ORIGIN,
      '--connect',
      fake.url,
      '--direct',
      fake.url,
      '--trigger-secret-file',
      secretFile,
      ...extraArgs,
    ])
    // Nothing secret is ever printed.
    assert.ok(!`${out.stdout}${out.stderr}`.includes(triggerSecret), 'the trigger secret was printed')
    assert.doesNotMatch(`${out.stdout}${out.stderr}`, /set-cookie|cookie:/i)
    return { ...out, results: results(out.stdout), seen: fake.seen }
  } finally {
    await fake.close()
  }
}

function assertOnlyFailed(out, failed) {
  assert.equal(out.code, 1, out.stdout + out.stderr)
  for (const name of CHECKS) {
    assert.equal(out.results.get(name), failed.includes(name) ? 'FAIL' : 'PASS', `${name}\n${out.stdout}`)
  }
}

test('a good origin passes every check and exits 0', async () => {
  const out = await smokeAgainst({})
  assert.equal(out.code, 0, out.stdout + out.stderr)
  assert.deepEqual([...out.results.keys()], CHECKS)
  for (const name of CHECKS) assert.equal(out.results.get(name), 'PASS', `${name}\n${out.stdout}`)
  // The forged checks really sent forged addresses, each request a different one.
  const forged = out.seen.filter((r) => r.url === '/api/v1/invites/lookup')
  assert.ok(forged.length >= 5)
  assert.equal(new Set(forged.map((r) => r.headers['cf-connecting-ip'])).size, forged.length)
  assert.equal(new Set(forged.map((r) => r.headers['x-forwarded-for'])).size, forged.length)
  // The checkpoint body was about 900 kB.
  const checkpoint = out.seen.find((r) => r.url.endsWith('/checkpoint'))
  assert.ok(checkpoint.bodyLength >= 900 * 1000 && checkpoint.bodyLength < 1024 * 1024)
})

test('a redirect from / to a page on the same origin is followed', async () => {
  const out = await smokeAgainst({ faults: { rootRedirect: true } })
  assert.equal(out.code, 0, out.stdout)
})

test('/api/health/ready answering 503 fails', async () => {
  assertOnlyFailed(await smokeAgainst({ faults: { readyStatus: 503 } }), ['ready'])
})

test('/api/health/worker answering 503 fails', async () => {
  assertOnlyFailed(await smokeAgainst({ faults: { workerStatus: 503 } }), ['worker'])
})

test('/ answering 500 fails', async () => {
  assertOnlyFailed(await smokeAgainst({ faults: { rootStatus: 500 } }), ['root'])
})

for (const header of [
  'x-frame-options',
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'strict-transport-security',
  'cross-origin-opener-policy',
]) {
  test(`a missing ${header} on / fails`, async () => {
    const out = await smokeAgainst({ faults: { dropHeader: header } })
    assertOnlyFailed(out, ['root'])
    assert.match(out.stdout, new RegExp(`FAIL +root .*${header}`))
  })
}

test('/api/v1/session answering anything but 401 without a cookie fails', async () => {
  assertOnlyFailed(await smokeAgainst({ faults: { sessionStatus: 200 } }), ['session'])
})

test('a forged CF-Connecting-IP or X-Forwarded-For that is believed fails both limiter checks', async () => {
  assertOnlyFailed(await smokeAgainst({ clientAddress: 'forwarded' }), ['forged-invite', 'forged-sign-in'])
})

test('a DELETE whose body does not reach the core fails', async () => {
  assertOnlyFailed(await smokeAgainst({ faults: { dropDeleteBody: true } }), ['delete-body'])
})

test('a proxy that refuses a 2 MiB document upload fails', async () => {
  const out = await smokeAgainst({ faults: { documentsBodyLimit: 1024 * 1024 } })
  assertOnlyFailed(out, ['document-body'])
  assert.match(out.stdout, /FAIL +document-body .*413/)
})

test('a proxy that refuses a 900 kB checkpoint body fails', async () => {
  const out = await smokeAgainst({ faults: { bodyLimit: 512 * 1024 } })
  assertOnlyFailed(out, ['checkpoint-body'])
  assert.match(out.stdout, /FAIL +checkpoint-body .*413/)
})

test('a query string dropped on the way to a trigger fails (with the trigger secret)', async () => {
  assertOnlyFailed(await smokeAgainst({ faults: { stripQuery: true } }), ['trigger'])
})

test('a wrong trigger secret fails the trigger check', async () => {
  assertOnlyFailed(await smokeAgainst({ triggerSecret: 'another-secret' }), ['trigger'])
})

test('the forged addresses differ from run to run', async () => {
  const forged = async () => {
    const out = await smokeAgainst({})
    assert.equal(out.code, 0, out.stdout)
    return out.seen
      .filter((r) => r.url === '/api/v1/invites/lookup' || r.url === '/api/auth/sign-in/email')
      .map((r) => `${r.headers['cf-connecting-ip']} ${r.headers['x-forwarded-for']}`)
  }
  const first = await forged()
  const second = await forged()
  // Every request of a run has its own pair, and the two runs do not repeat the same sequence.
  assert.equal(new Set(first).size, first.length)
  assert.notDeepEqual(first, second)
  for (const pair of [...first, ...second]) {
    assert.match(pair, /^203\.0\.113\.\d{1,3} 198\.51\.100\.\d{1,3}$/)
  }
})

test('an invite limiter that is already locked before any look-up fails (no proof)', async () => {
  const out = await smokeAgainst({ faults: { inviteLocked: true } })
  assertOnlyFailed(out, ['forged-invite'])
  assert.match(out.stdout, /FAIL +forged-invite .*already locked/)
})

test('a sign-in limiter that answers 429 before any 401 fails (no proof)', async () => {
  const out = await smokeAgainst({ faults: { signInLimited: true } })
  assertOnlyFailed(out, ['forged-sign-in'])
  assert.match(out.stdout, /FAIL +forged-sign-in .*already limited/)
})

test('a second run inside the lock window fails the limiter checks instead of passing without proof', async () => {
  const fake = await startFakeOrigin({ origin: ORIGIN, triggerSecret })
  try {
    const args = [ORIGIN, '--connect', fake.url, '--direct', fake.url, '--trigger-secret-file', secretFile]
    assert.equal((await runSmoke(args)).code, 0)
    const again = await runSmoke(args)
    const r = results(again.stdout)
    assert.equal(again.code, 1, again.stdout)
    assert.equal(r.get('forged-invite'), 'FAIL')
    assert.equal(r.get('forged-sign-in'), 'FAIL')
  } finally {
    await fake.close()
  }
})

test('without --direct the forged checks are skipped and the run exits 2', async () => {
  const fake = await startFakeOrigin({ origin: ORIGIN })
  try {
    const out = await runSmoke([ORIGIN, '--connect', fake.url])
    const r = results(out.stdout)
    assert.equal(out.code, 2, out.stdout)
    assert.equal(r.get('forged-invite'), 'SKIP')
    assert.equal(r.get('forged-sign-in'), 'SKIP')
    // No trigger secret either: that check cannot prove the query string survived, so it is skipped too.
    assert.equal(r.get('trigger'), 'SKIP')
    for (const name of CHECKS.filter((n) => !n.startsWith('forged-') && n !== 'trigger'))
      assert.equal(r.get(name), 'PASS', name)
  } finally {
    await fake.close()
  }
})

test('without the trigger secret the trigger check is skipped, even against a core that refuses', async () => {
  const fake = await startFakeOrigin({ origin: ORIGIN })
  try {
    const out = await runSmoke([ORIGIN, '--connect', fake.url, '--direct', fake.url])
    assert.equal(results(out.stdout).get('trigger'), 'SKIP', out.stdout)
    assert.equal(out.code, 2, out.stdout)
  } finally {
    await fake.close()
  }
})

test('--no-proxy skips the checks that need the proxy, and still fails a broken check', async () => {
  // A core and dashboard with no proxy in front: the proxy's headers are missing and the forged headers believed.
  const out = await smokeAgainst(
    { clientAddress: 'forwarded', faults: { dropHeader: 'strict-transport-security' } },
    ['--no-proxy'],
  )
  assert.equal(out.code, 2, out.stdout)
  assert.equal(out.results.get('forged-invite'), 'SKIP')
  assert.equal(out.results.get('forged-sign-in'), 'SKIP')
  assert.equal(out.results.get('root'), 'PASS')
  const broken = await smokeAgainst({ faults: { readyStatus: 503 } }, ['--no-proxy'])
  assert.equal(broken.code, 1)
})

test('an unreachable origin fails every check', async () => {
  const fake = await startFakeOrigin({ origin: ORIGIN })
  const url = fake.url
  await fake.close()
  const out = await runSmoke([
    ORIGIN,
    '--connect',
    url,
    '--direct',
    url,
    '--trigger-secret-file',
    secretFile,
    '--timeout',
    '2000',
  ])
  assert.equal(out.code, 1)
  for (const name of CHECKS) assert.equal(results(out.stdout).get(name), 'FAIL', name)
})

test('a usage error exits 64', async () => {
  assert.equal((await runSmoke([])).code, 64)
  assert.equal((await runSmoke(['not-a-url'])).code, 64)
  assert.equal((await runSmoke([ORIGIN, '--bogus'])).code, 64)
  assert.equal((await runSmoke([ORIGIN, '--header', 'no-colon'])).code, 64)
})
