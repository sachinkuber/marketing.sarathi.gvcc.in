// Acceptance test 39, the images half: the four production images build, are pinned, carry no secret and no
// staging patch, run as `node`, and start the way production starts them.
// Needs Docker and gitleaks. It fails, never skips, when either is missing. On the development server it runs
// through /opt/mkt-dev/server-run-infra.sh; in CI in the e2e job.
//   node --test infra/prod/test/images.test.mjs
// Images are tagged mkt-m7test-<target>:t39 and kept (the next run reuses their build cache). Every container
// this file starts is named mkt-m7test-* and removed, whether the tests pass or fail.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const dockerfile = join(root, 'infra/prod/Dockerfile')
const TARGETS = ['core', 'worker', 'dashboard', 'ops']
const tag = (target) => `mkt-m7test-${target}:t39`
// Within the 2 GB / 1.5 CPU cap of the development server's test containers.
const LIMITS = ['--memory', '512m', '--cpus', '0.5']
const containers = new Set()

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options })
}

function docker(args, options = {}) {
  const result = run('docker', args, options)
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-30).join('\n')
    throw new Error(`docker ${args.join(' ')} failed (${result.status ?? result.error}):\n${output}`)
  }
  return result.stdout
}

function container(name) {
  containers.add(name)
  return name
}

function removeContainer(name) {
  run('docker', ['rm', '--force', name])
  containers.delete(name)
}

before(() => {
  const version = run('docker', ['version', '--format', '{{.Server.Version}}'])
  if (version.status !== 0) throw new Error('Docker is not reachable. These tests need it and never skip.')
  const gitleaks = run('gitleaks', ['version'])
  if (gitleaks.status !== 0) throw new Error('gitleaks is not installed. These tests need it and never skip.')
})

after(() => {
  for (const name of [...containers]) removeContainer(name)
})

test('each target builds', { timeout: 60 * 60_000 }, (t) => {
  // One build at a time: the host's processors are shared with other projects.
  for (const target of TARGETS) {
    docker(['build', '--progress=plain', '-f', dockerfile, '--target', target, '-t', tag(target), root])
    const size = Number(docker(['image', 'inspect', '--format', '{{.Size}}', tag(target)]).trim())
    t.diagnostic(`${tag(target)}: ${(size / 1e6).toFixed(0)} MB`)
  }
})

test('every FROM is pinned by digest', () => {
  const dev = join(root, 'infra/dev')
  const others = readdirSync(dev).filter((name) => name.endsWith('Dockerfile'))
  for (const file of [dockerfile, ...others.map((name) => join(dev, name))]) {
    const stages = new Set()
    const froms = readFileSync(file, 'utf8').matchAll(/^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/gim)
    let count = 0
    for (const [, image, stage] of froms) {
      count++
      if (!stages.has(image.toLowerCase())) {
        assert.match(
          image,
          /^[a-z0-9./_-]+(:[\w.-]+)?@sha256:[0-9a-f]{64}$/,
          `${relative(root, file)}: FROM ${image}`,
        )
      }
      if (stage) stages.add(stage.toLowerCase())
    }
    assert.ok(count > 0, `${relative(root, file)} has no FROM`)
  }
})

// The pinned Node base image (the first FROM). It ships headers, scripts and certificate authorities that a
// scan flags (generic-api-key in /usr/include, *.pem in /etc/ssl): those are not ours. Each image's results
// are therefore compared with the base image's, and only what the build added or changed is reported.
const BASE = readFileSync(dockerfile, 'utf8').match(/^FROM\s+(\S+)/m)[1]

function* walk(dir, rel = '') {
  // Symbolic links are not followed (/lib points into /usr in the base image).
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name
    yield [path, entry]
    if (entry.isDirectory()) yield* walk(dir, path)
  }
}

// Exports an image's whole filesystem once, scans it, deletes it. Keys carry what tells a changed file apart
// from the base image's: a path's size, and a finding's line and entropy.
const scans = new Map()
function scan(ref, label) {
  if (scans.has(ref)) return scans.get(ref)
  const dir = mkdtempSync(join(tmpdir(), `mkt-t39-${label}-`))
  const reportDir = mkdtempSync(join(tmpdir(), `mkt-t39-report-`))
  const name = container(`mkt-m7test-export-${label}-${process.pid}`)
  try {
    // Only the base image may be pulled (by its digest); the others are the ones built above.
    docker(['create', ...(ref === BASE ? [] : ['--pull', 'never']), '--name', name, ref])
    // Device files are left out: they cannot be made without root, and hold nothing.
    const exported = run('bash', [
      '-c',
      'set -o pipefail; docker export "$1" | tar -x -C "$2" --no-same-owner --anchored --exclude="dev/*"',
      'bash',
      name,
      dir,
    ])
    assert.equal(exported.status, 0, `export of ${label} failed: ${exported.stderr}`)
  } finally {
    removeContainer(name)
  }
  try {
    const forbidden = new Map()
    for (const [path, entry] of walk(dir)) {
      const isEnv = entry.name.startsWith('.env') && entry.name !== '.env.example'
      const isPem = entry.name.endsWith('.pem')
      const isGit = entry.name === '.git'
      const isCache = /(^|\/)node_modules\/\.cache$/.test(path)
      if (isEnv || isPem || isGit || isCache)
        forbidden.set(`${path} (${lstatSync(join(dir, path)).size} B)`, path)
    }
    const report = join(reportDir, 'gitleaks.json')
    const leaks = run('gitleaks', [
      'dir',
      '--no-banner',
      '--redact',
      '--log-level',
      'error',
      '--config',
      join(root, '.gitleaks.toml'),
      '--report-format',
      'json',
      '--report-path',
      report,
      dir,
    ])
    assert.ok(leaks.status === 0 || leaks.status === 1, `gitleaks failed on ${label}: ${leaks.stderr}`)
    const findings = new Map(
      JSON.parse(readFileSync(report, 'utf8')).map((f) => {
        const where = `/${relative(dir, f.File)}:${f.StartLine}`
        return [`${f.RuleID} ${where} ${f.Entropy}`, `${f.RuleID} in ${where}`]
      }),
    )
    const grep = run('grep', ['-rlF', '--no-messages', 'MKT_SECOND_FACTOR', dir])
    assert.ok(grep.status === 0 || grep.status === 1, `grep failed on ${label} (${grep.status})`)
    const secondFactor = grep.stdout
      .split('\n')
      .filter(Boolean)
      .map((file) => `/${relative(dir, file)}`)
    const result = { forbidden, findings, secondFactor }
    scans.set(ref, result)
    return result
  } finally {
    // Extracted directories can be read-only; make them writable so they can be removed.
    run('chmod', ['-R', 'u+w', dir])
    rmSync(dir, { recursive: true, force: true })
    rmSync(reportDir, { recursive: true, force: true })
  }
}

// What an image has that the base image does not.
function added(target, kind) {
  const base = scan(BASE, 'base')[kind]
  return [...scan(tag(target), target)[kind]].filter(([key]) => !base.has(key)).map(([, shown]) => shown)
}

test('no image contains .env, a *.pem, .git or node_modules/.cache', { timeout: 30 * 60_000 }, () => {
  for (const target of TARGETS) assert.deepEqual(added(target, 'forbidden'), [], target)
})

// `next build` writes random keys of its own into two manifests: Draft Mode's (previewMode* in
// prerender-manifest.json) and the Server Actions encryption key. The dashboard uses neither feature (checked
// here), so those keys guard nothing. They are the only findings allowed, by exact file.
const NEXT_BUILD_KEYS = [
  /^generic-api-key in \/app\/apps\/dashboard\/\.next\/prerender-manifest\.json:\d+$/,
  /^generic-api-key in \/app\/apps\/dashboard\/\.next\/server\/server-reference-manifest\.json:\d+$/,
]

test("gitleaks finds nothing in any image's exported filesystem", { timeout: 30 * 60_000 }, () => {
  const src = join(root, 'apps/dashboard/src')
  for (const [path, entry] of walk(src)) {
    if (!entry.isFile()) continue
    const text = readFileSync(join(src, path), 'utf8')
    assert.doesNotMatch(
      text,
      /['"]use server['"]|draftMode/,
      `apps/dashboard/src/${path} uses a keyed Next.js feature`,
    )
  }
  for (const target of TARGETS) {
    const findings = added(target, 'findings')
    const allowed = target === 'dashboard' ? NEXT_BUILD_KEYS : []
    assert.deepEqual(
      findings.filter((f) => !allowed.some((pattern) => pattern.test(f))),
      [],
      target,
    )
  }
})

// better-auth lists next, react and react-dom as optional peers, and npm's workspace filter follows those edges,
// so `npm ci --workspace @mkt/core` installed the dashboard's framework (and its 93 MB compiler) into the core.
const DASHBOARD_ONLY = ['next', '@next', 'react', 'react-dom', 'playwright-core', 'happy-dom']

test('core, worker and ops carry none of the dashboard framework', () => {
  for (const target of ['core', 'worker', 'ops']) {
    const name = container(`mkt-m7test-modules-${target}-${process.pid}`)
    const present = docker([
      'run',
      '--pull',
      'never',
      '--rm',
      '--name',
      name,
      ...LIMITS,
      '--network',
      'none',
      '--entrypoint',
      'sh',
      tag(target),
      '-c',
      'for p in "$@"; do [ -e "node_modules/$p" ] && echo "$p"; done; true',
      'sh',
      ...DASHBOARD_ONLY,
    ])
    removeContainer(name)
    assert.deepEqual(present.split('\n').filter(Boolean), [], target)
  }
})

test('core and worker run as uid 1000 (node)', () => {
  // The dashboard and ops images run as node too.
  for (const target of TARGETS) {
    assert.equal(
      docker(['image', 'inspect', '--format', '{{.Config.User}}', tag(target)]).trim(),
      'node',
      target,
    )
    const name = container(`mkt-m7test-id-${target}-${process.pid}`)
    const id = docker([
      'run',
      '--pull',
      'never',
      '--rm',
      '--name',
      name,
      ...LIMITS,
      '--network',
      'none',
      '--entrypoint',
      'id',
      tag(target),
      '-u',
    ])
    removeContainer(name)
    assert.equal(id.trim(), '1000', target)
  }
})

test('no image contains the string MKT_SECOND_FACTOR', { timeout: 30 * 60_000 }, () => {
  // The staging deployment patches the second factor off (plan, defect b). That patch must never ship.
  // Checked in the whole filesystem, base image included.
  for (const target of TARGETS) assert.deepEqual(scan(tag(target), target).secondFactor, [], target)
})

test('core and worker start with plain node (no --experimental-transform-types)', () => {
  for (const target of ['core', 'worker']) {
    const config = JSON.parse(docker(['image', 'inspect', '--format', '{{json .Config}}', tag(target)]))
    assert.deepEqual(
      [...(config.Entrypoint ?? []), ...(config.Cmd ?? [])],
      ['node', `apps/${target}/src/main.ts`],
    )
    assert.ok(!config.Env.some((e) => e.startsWith('NODE_OPTIONS=')), `${target} sets NODE_OPTIONS`)
    // With no configuration the service must load every module (no syntax error, no missing package or file)
    // and stop at the configuration check, as apps/core/test/entry-plain-node.test.ts checks in development.
    const name = container(`mkt-m7test-start-${target}-${process.pid}`)
    const started = run(
      'docker',
      ['run', '--pull', 'never', '--rm', '--name', name, ...LIMITS, '--network', 'none', tag(target)],
      {
        timeout: 120_000,
      },
    )
    removeContainer(name)
    assert.doesNotMatch(
      started.stderr,
      /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_MODULE_NOT_FOUND|ENOENT/,
      target,
    )
    assert.match(started.stderr, /Invalid configuration:/, `${target}: ${started.stderr}`)
    assert.notEqual(started.status, 0, target)
  }
})

test('the dashboard image starts and answers / with 200 and no Next.js "next start" warning', async () => {
  const name = container(`mkt-m7test-dashboard-${process.pid}`)
  docker([
    'run',
    '--pull',
    'never',
    '--detach',
    '--name',
    name,
    ...LIMITS,
    '--publish',
    '127.0.0.1::3000',
    tag('dashboard'),
  ])
  const port = docker(['port', name, '3000/tcp']).trim().split('\n')[0].split(':').pop()
  let status = 0
  for (let i = 0; i < 60 && status !== 200; i++) {
    status = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' }).then(
      (response) => response.status,
      () => 0,
    )
    if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const logs = run('docker', ['logs', name])
  removeContainer(name)
  assert.equal(status, 200, `${logs.stdout}${logs.stderr}`)
  assert.doesNotMatch(`${logs.stdout}${logs.stderr}`, /next start/)
})
