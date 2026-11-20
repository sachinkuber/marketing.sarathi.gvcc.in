#!/usr/bin/env node
// Smoke check of a deployed origin (plan M7, Task 7 step 2). Needs only Node; no dependency.
//
//   node infra/prod/smoke.mjs <origin> [options]
//
//   <origin>                      The public origin, e.g. https://marketing.sarathi.gvcc.in. Every request carries
//                                 its host (Host header and TLS name) and, where the core asks for one, it as Origin.
//   --connect <url>               Send the ordinary checks to this address instead of looking the origin's name
//                                 up, e.g. https://127.0.0.1:443. Default: the origin itself (through Cloudflare).
//   --direct <url>                Where the two forged-address checks connect: the origin server itself, NOT
//                                 Cloudflare. On the production host: --direct https://127.0.0.1:443. The
//                                 certificate is not verified on this connection (an origin certificate is not
//                                 publicly trusted; this check is about the limiters, not TLS). Without it those
//                                 two checks are skipped.
//   --trigger-secret-file <path>  A file holding TRIGGER_SECRET (e.g. read from core.env into a 0600 file). With
//                                 it the trigger check also sends one correctly signed ping, proving the path,
//                                 headers and body reach the core unchanged, and that a query string is refused
//                                 even when the bare path is correctly signed. Never printed. Without it the
//                                 trigger check is SKIP: it cannot prove the query string survived.
//   --header <name:value>         Add a header to every request (repeatable; never printed).
//   --insecure                    Do not verify certificates on --connect either (rehearsals with a local CA).
//   --no-proxy                    Nothing in front of the core and dashboard (local rehearsal): the checks that
//                                 need the proxy (its headers, the forged addresses) are skipped.
//   --timeout <ms>                Per request (default 15000).
//
// One line per check: "PASS|FAIL|SKIP <check> <detail>". Exit 0 when every check passed, 1 when any failed,
// 2 when none failed but some were skipped (an incomplete run), 64 on a usage error.
// It prints statuses and error codes only: never a body, a cookie, a header value it was given, or a secret.
//
// Side effects on the target (all harmless, all expected): six failed invite look-ups, which lock invite
// look-ups for the --direct address for 15 minutes (a second run inside that time fails forged-invite as
// "already locked", by design: it could prove nothing); up to five failed sign-ins for made-up addresses
// (@example.invalid), audited as auth.sign_in failures; with the trigger secret, one trigger.received audit
// entry for workflow "smoke-check".
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'

const USAGE =
  'usage: node infra/prod/smoke.mjs <origin> [--connect <url>] [--direct <url>] ' +
  '[--trigger-secret-file <path>] [--header <name:value>]... [--insecure] [--no-proxy] [--timeout <ms>]'

function usage(message) {
  process.stderr.write(`${message}\n${USAGE}\n`)
  process.exit(64)
}

function parseUrl(value, what) {
  let url
  try {
    url = new URL(value)
  } catch {
    usage(`${what} is not a URL`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) usage(`${what} must be http: or https:`)
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    usage(`${what} must be a bare origin, without a path, query or credentials`)
  }
  return url
}

function parseArgs(argv) {
  const options = { headers: {}, insecure: false, proxy: true, timeoutMs: 15000 }
  const rest = [...argv]
  const value = (flag) => {
    const v = rest.shift()
    if (v === undefined) usage(`${flag} needs a value`)
    return v
  }
  while (rest.length > 0) {
    const arg = rest.shift()
    if (arg === '--connect') options.connect = parseUrl(value(arg), '--connect')
    else if (arg === '--direct') options.direct = parseUrl(value(arg), '--direct')
    else if (arg === '--trigger-secret-file') {
      const path = value(arg)
      try {
        options.triggerSecret = readFileSync(path, 'utf8').trim()
      } catch {
        usage('--trigger-secret-file cannot be read')
      }
      if (!options.triggerSecret) usage('--trigger-secret-file is empty')
    } else if (arg === '--header') {
      const [, name, v] = value(arg).match(/^([A-Za-z0-9-]+):\s*(.*)$/) ?? []
      if (!name) usage('--header must be name:value')
      options.headers[name.toLowerCase()] = v
    } else if (arg === '--insecure') options.insecure = true
    else if (arg === '--no-proxy') options.proxy = false
    else if (arg === '--timeout') {
      options.timeoutMs = Number(value(arg))
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) usage('--timeout must be a number')
    } else if (arg.startsWith('-')) usage(`unknown option ${arg}`)
    else if (options.origin) usage('only one origin')
    else options.origin = parseUrl(arg, 'the origin')
  }
  if (!options.origin) usage('the origin is missing')
  return options
}

const options = parseArgs(process.argv.slice(2))
const origin = options.origin
const ORIGIN = origin.origin

// One request, by hand, so the address connected to can differ from the origin's name. Resolves with the status,
// the headers and at most 64 kB of the body; a response that arrives while the body is still being sent counts.
function request(path, { method = 'GET', headers = {}, body, direct = false } = {}) {
  const target = direct ? options.direct : (options.connect ?? origin)
  const secure = target.protocol === 'https:'
  const client = secure ? https : http
  const payload = body === undefined ? undefined : Buffer.from(body)
  const all = {
    host: origin.host,
    'user-agent': 'mkt-smoke',
    ...options.headers,
    ...headers,
    ...(payload ? { 'content-length': String(payload.length) } : {}),
  }
  return new Promise((resolve, reject) => {
    let answered = false
    const req = client.request({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || (secure ? 443 : 80),
      method,
      path,
      headers: all,
      agent: false,
      ...(secure
        ? {
            ...(isIP(origin.hostname) ? {} : { servername: origin.hostname }),
            rejectUnauthorized: !(direct || options.insecure),
          }
        : {}),
    })
    const timer = setTimeout(
      () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })),
      options.timeoutMs,
    )
    req.on('response', (res) => {
      answered = true
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        if (size < 65536) chunks.push(chunk)
        size += chunk.length
      })
      res.on('end', () => {
        clearTimeout(timer)
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      res.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    req.on('error', (err) => {
      // The server may answer and close before the whole body is sent (the core refuses a checkpoint before
      // reading it); the answer is what counts.
      if (answered) return
      clearTimeout(timer)
      reject(err)
    })
    if (payload) req.write(payload)
    req.end()
  })
}

function codeOf(response) {
  try {
    const parsed = JSON.parse(response.body)
    return parsed?.error?.code ?? parsed?.code ?? null
  } catch {
    return null
  }
}

const described = (r) => `${r.status}${codeOf(r) ? ` ${codeOf(r)}` : ''}`
const uuid = () => randomUUID()
const hex = (bytes) => randomBytes(bytes).toString('hex')

class Skip {
  constructor(reason) {
    this.reason = reason
  }
}

async function health(path) {
  const r = await request(path)
  if (r.status !== 200) throw new Error(`${path} answered ${described(r)}, not 200`)
  return `${path} 200`
}

async function root() {
  let path = '/'
  let r
  for (let hop = 0; ; hop++) {
    r = await request(path)
    if (r.status < 300 || r.status >= 400 || !r.headers.location) break
    if (hop === 5) throw new Error('/ redirects more than 5 times')
    const next = new URL(r.headers.location, ORIGIN)
    if (next.origin !== ORIGIN) throw new Error(`/ redirects off the origin (${r.status})`)
    path = `${next.pathname}${next.search}`
  }
  if (r.status !== 200) throw new Error(`/ answered ${r.status}, not 200`)
  const problems = []
  const h = r.headers
  const need = (name, test, wanted) => {
    const v = h[name]
    if (v === undefined) problems.push(`missing ${name}`)
    else if (!test(String(v))) problems.push(`${name} is not ${wanted}`)
  }
  need('content-security-policy', (v) => /default-src/.test(v), 'a policy with default-src')
  need('x-content-type-options', (v) => v.toLowerCase() === 'nosniff', 'nosniff')
  need('x-frame-options', (v) => v.toUpperCase() === 'DENY', 'DENY')
  need('referrer-policy', (v) => v.length > 0, 'set')
  need('permissions-policy', (v) => /camera=\(\)/.test(v), 'restrictive')
  if (options.proxy) {
    // Set by the proxy (the app leaves them to it): HSTS for at least 180 days, and COOP.
    need(
      'strict-transport-security',
      (v) => Number(v.match(/max-age=(\d+)/)?.[1] ?? 0) >= 15552000,
      'max-age of at least 180 days',
    )
    need('cross-origin-opener-policy', (v) => v === 'same-origin', 'same-origin')
  }
  if (problems.length > 0) throw new Error(problems.join('; '))
  return options.proxy
    ? '200 with the security headers'
    : '200 with the app security headers (no proxy: HSTS, COOP not checked)'
}

async function session() {
  const r = await request('/api/v1/session')
  if (r.status !== 401) throw new Error(`answered ${described(r)} without a cookie, not 401`)
  return `401 ${codeOf(r) ?? ''}`.trim()
}

// The signature covers the method, the path exactly as received, the time, a nonce and the body's hash
// (apps/core/src/triggers/signature.ts). The bare path is signed and sent with a query string: a core that
// gets the query refuses it (query_string), whatever the signature; a proxy that dropped the query would let
// the correctly signed call through (only provable with the secret).
async function trigger() {
  const path = '/api/v1/triggers/ping'
  const body = JSON.stringify({ workflow: 'smoke-check' })
  const signed = (url, key) => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = hex(32)
    const text = ['POST', url, timestamp, nonce, createHash('sha256').update(body).digest('hex')].join('\n')
    return {
      'content-type': 'application/json',
      'x-mkt-timestamp': timestamp,
      'x-mkt-nonce': nonce,
      'x-mkt-signature': createHmac('sha256', key).update(text).digest('hex'),
    }
  }
  // Without the secret the call is signed with a random key, so a 401 trigger_refused comes back whether or not
  // the proxy kept the query string: nothing is proved, so the check is skipped (the run exits 2), not passed.
  if (!options.triggerSecret)
    return new Skip(
      'no --trigger-secret-file: a query string kept by the proxy cannot be told from one dropped',
    )
  const key = options.triggerSecret
  const refused = await request(`${path}?smoke=1`, { method: 'POST', headers: signed(path, key), body })
  if (refused.status !== 401 || codeOf(refused) !== 'trigger_refused') {
    throw new Error(`a trigger with a query string answered ${described(refused)}, not 401 trigger_refused`)
  }
  const accepted = await request(path, { method: 'POST', headers: signed(path, key), body })
  if (accepted.status !== 200) {
    throw new Error(`a correctly signed trigger answered ${described(accepted)}, not 200`)
  }
  return 'with a query string 401 trigger_refused; correctly signed 200'
}

// Documentation ranges (RFC 5737): a different made-up address on every request, drawn afresh on every run, so
// a run never meets an address an earlier run locked. 11 distinct host parts: 6 for invites, 5 for sign-ins.
const forgedHosts = (() => {
  const pool = Array.from({ length: 254 }, (_, i) => i + 1)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE(0) % (i + 1)
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, 11)
})()

function forgedHeaders(n) {
  const host = forgedHosts[n]
  return { 'cf-connecting-ip': `203.0.113.${host}`, 'x-forwarded-for': `198.51.100.${host}` }
}

function needsDirect() {
  if (!options.proxy) return new Skip('needs the proxy')
  if (!options.direct) return new Skip('needs --direct <url> (the origin server, not Cloudflare)')
  return null
}

// Each limiter check proves something only if the limiter first let a request through (counted it) and then
// refused a later one carrying a different forged address. A 429 before that proves nothing: the real
// address is still locked from an earlier run, or the limiter keys on something the run cannot see.

// The invite limiter keys on the client address and locks after 5 failures (apps/core/src/auth/policy.ts).
async function forgedInvite() {
  const skip = needsDirect()
  if (skip) return skip
  let counted = 0
  for (let i = 1; i <= 6; i++) {
    const r = await request('/api/v1/invites/lookup', {
      method: 'POST',
      direct: true,
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...forgedHeaders(i - 1) },
      body: JSON.stringify({ token: hex(32) }),
    })
    if (r.status === 429) {
      if (counted === 0) {
        throw new Error('invite look-ups were already locked before this run: wait 15 minutes and run again')
      }
      return `limited (429) at attempt ${i} after ${counted} counted, each with a different forged address`
    }
    if (r.status !== 410) throw new Error(`invite look-up ${i} answered ${described(r)}, not 410 or 429`)
    counted++
  }
  throw new Error('6 failed look-ups, each with a different forged address, were never limited (429)')
}

// Better Auth's own limiter: 3 sign-ins per 10 s per client address. Each attempt uses a different made-up
// account, so the per-account lockout cannot be what answers 429.
async function forgedSignIn() {
  const skip = needsDirect()
  if (skip) return skip
  const run = hex(4)
  let counted = 0
  for (let i = 1; i <= 5; i++) {
    const r = await request('/api/auth/sign-in/email', {
      method: 'POST',
      direct: true,
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...forgedHeaders(5 + i) },
      body: JSON.stringify({ email: `smoke-${run}-${i}@example.invalid`, password: hex(16) }),
    })
    if (r.status === 429) {
      if (counted === 0) {
        throw new Error('sign-ins were already limited before this run: wait 10 seconds and run again')
      }
      return `limited (429) at attempt ${i} after ${counted} counted, each with a different forged address`
    }
    if (r.status !== 401) throw new Error(`sign-in ${i} answered ${described(r)}, not 401 or 429`)
    counted++
  }
  throw new Error(
    '5 sign-ins in a few seconds, each with a different forged address, were never limited (429)',
  )
}

// A body the core's JSON parser refuses (400 invalid_json) proves the DELETE body reached it; a dropped body
// would reach the route and be refused as not signed in (401).
async function deleteBody() {
  const r = await request(`/api/v1/brands/${uuid()}/users/${uuid()}`, {
    method: 'DELETE',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: '{"code":',
  })
  if (r.status !== 400 || codeOf(r) !== 'invalid_json') {
    throw new Error(
      `a DELETE with a body answered ${described(r)}, not 400 invalid_json: the body did not arrive`,
    )
  }
  return '400 invalid_json: the body reached the core'
}

// 900 kB (921600 bytes) to the checkpoint route with a wrong worker credential: the core refuses the
// credential (401 unauthorized); a proxy that refused the size would answer 413 first.
async function checkpointBody() {
  const size = 900 * 1024
  const head = '{"pad":"'
  const body = `${head}${'a'.repeat(size - head.length - 2)}"}`
  const r = await request(`/api/v1/worker/jobs/${uuid()}/model-calls/${uuid()}/checkpoint`, {
    method: 'POST',
    headers: { authorization: 'Worker smoke-check-not-a-credential', 'content-type': 'application/json' },
    body,
  })
  if (r.status === 413) throw new Error('a 900 kB body was refused by the proxy (413)')
  if (r.status !== 401 || codeOf(r) !== 'unauthorized') {
    throw new Error(`a 900 kB checkpoint answered ${described(r)}, not the core's 401 unauthorized`)
  }
  return `${body.length} bytes reached the core (401 unauthorized)`
}

// 2 MiB (2097152 bytes) to the document upload route, without a session: the core refuses it as not signed in
// (401 or 403); a proxy still holding the 1 MiB site limit would answer 413 first. Only that route is raised
// (to 101 MiB), so a 2 MiB body to any other path is still refused: not checked here, the proxy test does.
async function documentBody() {
  const size = 2 * 1024 * 1024
  const r = await request(`/api/v1/brands/${uuid()}/onboarding/documents`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/pdf', 'x-file-name': 'smoke-check.pdf' },
    body: Buffer.alloc(size, 0x61),
  })
  if (r.status === 413) throw new Error('a 2 MiB document upload was refused by the proxy (413)')
  if (r.status !== 401 && r.status !== 403) {
    throw new Error(`a 2 MiB document upload answered ${described(r)}, not the core's 401 or 403`)
  }
  return `${size} bytes reached the core (${described(r)})`
}

const CHECKS = [
  ['ready', () => health('/api/health/ready')],
  ['worker', () => health('/api/health/worker')],
  ['root', root],
  ['session', session],
  ['trigger', trigger],
  ['forged-invite', forgedInvite],
  ['forged-sign-in', forgedSignIn],
  ['delete-body', deleteBody],
  ['checkpoint-body', checkpointBody],
  ['document-body', documentBody],
]

const counts = { PASS: 0, FAIL: 0, SKIP: 0 }
for (const [name, check] of CHECKS) {
  let outcome
  let detail
  try {
    const result = await check()
    if (result instanceof Skip) [outcome, detail] = ['SKIP', result.reason]
    else [outcome, detail] = ['PASS', result]
  } catch (err) {
    outcome = 'FAIL'
    // A network error by its code only (no address); a check's own message as written above.
    detail = err?.code ? `error ${err.code}` : (err?.message ?? String(err))
  }
  counts[outcome]++
  process.stdout.write(`${outcome} ${name.padEnd(16)} ${detail}\n`)
}
process.stdout.write(
  `smoke ${ORIGIN}: ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.SKIP} skipped\n`,
)
process.exitCode = counts.FAIL > 0 ? 1 : counts.SKIP > 0 ? 2 : 0
