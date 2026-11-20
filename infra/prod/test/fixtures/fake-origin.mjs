// A small stand-in for the deployed product, for the smoke script's tests (smoke.test.mjs) and the proxy site's
// test (proxy.test.mjs). It answers the requests infra/prod/smoke.mjs makes the way the real core and dashboard
// do (statuses and error codes copied from apps/core), and each fault breaks one of them.
//
// origin: the origin, or a list of them, that state-changing requests must carry in Origin.
// role: 'both' (one server is the core and the dashboard), 'core' (only /api/), or 'dashboard' (everything else).
// clientAddress, how the limiters find the caller's address:
//   'socket'     the connection's address: a proxy in front that replaced the forwarded headers (good).
//   'forwarded'  CF-Connecting-IP or the first X-Forwarded-For entry, as sent: what a forged header defeats (bad).
//   'core'       what the real core does: the invite limiter takes the last X-Forwarded-For entry (Express with
//                trust proxy 1), the sign-in limiter takes X-Forwarded-For only when it holds one address (Better
//                Auth), otherwise one shared bucket.
// Paths under /api/echo/ (core) and /echo/ (dashboard) answer with what arrived, for the proxy test.
import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const CHECKPOINT = new RegExp(`^/api/v1/worker/jobs/${UUID}/model-calls/${UUID}/checkpoint$`)
const DOCUMENTS = new RegExp(`^/api/v1/brands/${UUID}/onboarding/documents$`)
const REMOVE_MEMBER = new RegExp(`^/api/v1/brands/${UUID}/users/${UUID}$`)
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
}
// Set by the proxy in production; the 'both' role sets them too unless a fault drops one.
const PROXY_HEADERS = {
  'strict-transport-security': 'max-age=31536000',
  'cross-origin-opener-policy': 'same-origin',
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}
const error = (res, status, code) => json(res, status, { error: { code, message: code } })

export async function startFakeOrigin(options = {}) {
  const {
    role = 'both',
    origin = 'https://smoke.example.test',
    clientAddress = 'socket',
    triggerSecret = null,
    workerSecret = 'not-the-smoke-credential',
    faults = {},
  } = options
  // One origin, or several (the proxy test runs two proxies in front of one core).
  const origins = new Set([origin].flat())
  const invites = new Map()
  const signIns = new Map()
  const seen = []

  function addresses(req) {
    const socket = req.socket.remoteAddress ?? 'unknown'
    const xff = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const cf = req.headers['cf-connecting-ip']
    if (clientAddress === 'forwarded') {
      const forged = typeof cf === 'string' ? cf : (xff[0] ?? socket)
      return { invite: forged, signIn: forged }
    }
    if (clientAddress === 'core') {
      return { invite: xff.at(-1) ?? socket, signIn: xff.length === 1 ? xff[0] : 'no-trusted-ip' }
    }
    return { invite: socket, signIn: socket }
  }

  async function core(req, res, path, body) {
    const status = (name, fallback) => faults[name] ?? fallback
    if (req.method === 'GET' && path === '/api/health/ready') {
      const s = status('readyStatus', 200)
      return json(res, s, { status: s === 200 ? 'ok' : 'unavailable' })
    }
    if (req.method === 'GET' && path === '/api/health/worker') {
      const s = status('workerStatus', 200)
      return json(res, s, { status: s === 200 ? 'ok' : 'stale' })
    }
    if (req.method === 'GET' && path === '/api/v1/session') {
      const s = status('sessionStatus', 401)
      return s === 401 ? error(res, 401, 'not_signed_in') : json(res, s, { user: { id: 'x' } })
    }
    if (path.startsWith('/api/v1/triggers/')) {
      const url = faults.stripQuery ? path : req.url
      if (url.includes('?')) return error(res, 401, 'trigger_refused')
      const text = [
        req.method,
        url,
        req.headers['x-mkt-timestamp'],
        req.headers['x-mkt-nonce'],
        createHash('sha256').update(body).digest('hex'),
      ].join('\n')
      const expected = triggerSecret && createHmac('sha256', triggerSecret).update(text).digest('hex')
      if (!expected || req.headers['x-mkt-signature'] !== expected) return error(res, 401, 'trigger_refused')
      return json(res, 200, { ok: true })
    }
    if (req.method !== 'GET' && !origins.has(req.headers.origin) && !path.startsWith('/api/v1/worker/')) {
      return error(res, 403, 'bad_origin')
    }
    if (req.method === 'POST' && path === '/api/v1/invites/lookup') {
      const key = addresses(req).invite
      if (faults.inviteLocked) return error(res, 429, 'too_many_attempts')
      const failures = invites.get(key) ?? 0
      if (failures >= 5) return error(res, 429, 'too_many_attempts')
      invites.set(key, failures + 1)
      return error(res, 410, 'invite_invalid')
    }
    if (req.method === 'POST' && path === '/api/auth/sign-in/email') {
      const key = addresses(req).signIn
      // Better Auth's rule for /sign-in: 3 per 10 s per address.
      const now = Date.now()
      const recent = (signIns.get(key) ?? []).filter((at) => now - at < 10_000)
      recent.push(now)
      signIns.set(key, recent)
      if (faults.signInLimited || recent.length > 3) {
        return json(res, 429, { message: 'Too many requests. Please try again later.' })
      }
      return json(res, 401, { code: 'INVALID_EMAIL_OR_PASSWORD' })
    }
    if (req.method === 'DELETE' && REMOVE_MEMBER.test(path)) {
      const received = faults.dropDeleteBody ? Buffer.alloc(0) : body
      if (received.length > 0) {
        try {
          JSON.parse(received.toString('utf8'))
        } catch {
          return error(res, 400, 'invalid_json')
        }
      }
      return error(res, 401, 'not_signed_in')
    }
    if (req.method === 'POST' && CHECKPOINT.test(path)) {
      if (faults.bodyLimit !== undefined && body.length > faults.bodyLimit) {
        res.writeHead(413, { 'content-type': 'text/plain' })
        return res.end('Request Entity Too Large')
      }
      if (req.headers.authorization !== `Worker ${workerSecret}`) return error(res, 401, 'unauthorized')
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && DOCUMENTS.test(path)) {
      if (faults.documentsBodyLimit !== undefined && body.length > faults.documentsBodyLimit) {
        res.writeHead(413, { 'content-type': 'text/plain' })
        return res.end('Request Entity Too Large')
      }
      return error(res, 401, 'not_signed_in')
    }
    return error(res, 404, 'not_found')
  }

  function dashboard(req, res, path) {
    if (path === '/' && faults.rootRedirect && !req.url.includes('signed-out')) {
      res.writeHead(307, { location: '/?signed-out=1' })
      return res.end()
    }
    const headers = { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS }
    if (role === 'both') Object.assign(headers, PROXY_HEADERS)
    if (faults.dropHeader) delete headers[faults.dropHeader]
    res.writeHead(path === '/' ? (faults.rootStatus ?? 200) : 404, headers)
    res.end('<!doctype html><title>Marketing platform</title>')
  }

  const server = createServer(async (req, res) => {
    try {
      const body = await readBody(req)
      const path = req.url.split('?')[0]
      seen.push({ method: req.method, url: req.url, headers: req.headers, bodyLength: body.length })
      const isApi = path.startsWith('/api/')
      if (path.startsWith('/api/echo/') || path.startsWith('/echo/')) {
        return json(res, 200, {
          role,
          method: req.method,
          url: req.url,
          headers: req.headers,
          bodyLength: body.length,
          bodySha256: createHash('sha256').update(body).digest('hex'),
        })
      }
      if (role === 'core' && !isApi) return error(res, 502, 'core_got_a_page_request')
      if (role === 'dashboard' && isApi) return error(res, 502, 'dashboard_got_an_api_request')
      if (isApi) return await core(req, res, path, body)
      return dashboard(req, res, path)
    } catch (err) {
      json(res, 500, { error: { code: 'fake_failed', message: String(err) } })
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  }
}
