import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkSignature, sign, signingText } from '../../apps/core/src/triggers/signature.ts'

const load = (name) => {
  const raw = readFileSync(new URL(`../../n8n/${name}.json`, import.meta.url), 'utf8')
  return { raw, wf: JSON.parse(raw) }
}
const heartbeat = load('marketing-daily-heartbeat')
const canary = load('marketing-canary')
const node = (wf, name) => {
  const found = wf.nodes.find((n) => n.name === name)
  if (!found) throw new Error(`no node named ${name}`)
  return found
}
const assignment = (n, name) => n.parameters.assignments.assignments.find((a) => a.name === name)
const targets = (wf, from, output = 0) => (wf.connections[from]?.main?.[output] ?? []).map((c) => c.node)

describe('exported n8n workflows', () => {
  it('have the names fixed by the spec and are exported inactive', () => {
    expect(heartbeat.wf.name).toBe('Marketing — daily heartbeat')
    expect(canary.wf.name).toBe('Marketing — canary')
    expect(heartbeat.wf.active).toBe(false)
    expect(canary.wf.active).toBe(false)
  })

  it.each([
    ['heartbeat', heartbeat],
    ['canary', canary],
  ])('%s holds no secret, address or literal URL', (_label, { raw }) => {
    expect(raw).not.toMatch(/https?:\/\//i)
    expect(raw).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
    expect(raw).not.toMatch(/[0-9a-f]{32,}/i) // hex secrets and keys
    expect(raw).not.toMatch(/[A-Za-z0-9+/_-]{40,}/) // long token-like strings
    expect(raw).not.toMatch(/-----BEGIN/)
  })

  it('canary is a minute timer that records its run time and calls nothing', () => {
    const types = canary.wf.nodes.map((n) => n.type)
    expect(types).toEqual(['n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.set'])
    const [trigger, set] = canary.wf.nodes
    expect(trigger.parameters.rule.interval).toEqual([{ field: 'minutes', minutesInterval: 1 }])
    expect(assignment(set, 'ranAt').value).toContain('$now')
  })

  it('heartbeat runs daily at 02:30 Asia/Kolkata', () => {
    const trigger = heartbeat.wf.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger')
    expect(trigger.parameters.rule.interval).toEqual([
      { field: 'days', daysInterval: 1, triggerAtHour: 2, triggerAtMinute: 30 },
    ])
    expect(heartbeat.wf.settings.timezone).toBe('Asia/Kolkata')
  })

  it('heartbeat builds the request, signs it with a credential and posts the exact signed body', () => {
    const wf = heartbeat.wf
    const build = node(wf, 'Build request')
    expect(assignment(build, 'body').value).toBe('{"workflow":"marketing-daily-heartbeat"}')
    expect(assignment(build, 'path').value).toBe('/api/v1/triggers/daily')
    expect(assignment(build, 'path').value).not.toContain('?')
    expect(assignment(build, 'ts').value).toContain('Math.floor(Date.now()/1000)')

    const nonce = node(wf, 'Generate nonce')
    expect(nonce.parameters).toMatchObject({
      action: 'generate',
      encodingType: 'hex',
      dataPropertyName: 'nonce',
    })

    const hash = node(wf, 'Hash body')
    expect(hash.parameters).toMatchObject({ action: 'hash', type: 'SHA256', encoding: 'hex' })
    expect(hash.parameters.value).toBe('={{ $json.body }}')
    expect(hash.parameters.dataPropertyName).toBe('bodyHash')

    const hmac = node(wf, 'Sign text')
    expect(hmac.parameters).toMatchObject({ action: 'hmac', type: 'SHA256', encoding: 'hex' })
    expect(hmac.parameters.value).toBe('={{ $json.text }}')
    expect(hmac.parameters.dataPropertyName).toBe('signature')
    expect(hmac.credentials.crypto.name).toBe('Marketing trigger secret')
    for (const key of Object.keys(hmac.parameters))
      expect(key.toLowerCase()).not.toMatch(/secret|key|password|token/)
    expect(JSON.stringify(hmac.parameters)).not.toMatch(/secret/i)

    const http = node(wf, 'Call core')
    const p = http.parameters
    expect(p.method).toBe('POST')
    expect(p.url).toBe('={{ $vars.MKT_CORE_ORIGIN }}{{ $json.path }}')
    expect(p.sendBody).toBe(true)
    expect(p.contentType).toBe('raw')
    expect(p.rawContentType).toBe('application/json')
    expect(p.body).toBe('={{ $json.body }}')
    const headers = Object.fromEntries(p.headerParameters.parameters.map((h) => [h.name, h.value]))
    expect(headers).toEqual({
      'X-Mkt-Timestamp': '={{ $json.ts }}',
      'X-Mkt-Nonce': '={{ $json.nonce }}',
      'X-Mkt-Signature': '={{ $json.signature }}',
    })
    expect(http.onError).toBe('continueErrorOutput')
  })

  it('heartbeat chain runs build, nonce, hash, text, sign, call in order', () => {
    const wf = heartbeat.wf
    const trigger = wf.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger').name
    expect(targets(wf, trigger)).toEqual(['Build request'])
    expect(targets(wf, 'Build request')).toEqual(['Generate nonce'])
    expect(targets(wf, 'Generate nonce')).toEqual(['Hash body'])
    expect(targets(wf, 'Hash body')).toEqual(['Build signing text'])
    expect(targets(wf, 'Build signing text')).toEqual(['Sign text'])
    expect(targets(wf, 'Sign text')).toEqual(['Call core'])
  })

  it('a retry goes back to the node that builds the timestamp and nonce, never straight to the call', () => {
    const wf = heartbeat.wf
    expect(targets(wf, 'Call core', 0)).toEqual([])
    expect(targets(wf, 'Call core', 1)).toEqual(['Count attempt'])
    expect(targets(wf, 'Count attempt')).toEqual(['Retries left?'])
    expect(targets(wf, 'Retries left?', 0)).toEqual(['Wait before retry'])
    expect(targets(wf, 'Wait before retry')).toEqual(['Build request'])
    const wait = node(wf, 'Wait before retry').parameters
    expect(wait).toMatchObject({ resume: 'timeInterval', amount: 10, unit: 'minutes' })
    for (const [from, outs] of Object.entries(wf.connections)) {
      for (const output of outs.main)
        for (const c of output) {
          if (c.node === 'Call core') expect(from).toBe('Sign text')
        }
    }
    expect(node(wf, 'Retries left?').parameters.conditions.conditions[0].rightValue).toBe(4)
  })
})

// A small interpreter over the exported JSON. It follows the connections node by node with one item,
// evaluates the n8n expressions for real, and records every $json field an expression reads that is not on
// the item at that point (a field lost by a Set node without includeOtherFields shows up here).
const KEY = 'fixed-test-key-not-a-real-one'
const ORIGIN = 'https://core.test'
const PATH = '/api/v1/triggers/daily'
const BODY = '{"workflow":"marketing-daily-heartbeat"}'
const OPTIONAL = { 'Build request': ['attempt'] }

function simulate(wf, { generated, respond }) {
  const missing = []
  const requests = []
  const visited = []
  const outputs = {}
  const callCrypto = (n, item, ev) => {
    const p = n.parameters
    if (p.action === 'generate') return { ...item, [p.dataPropertyName]: generated(p.stringLength) }
    if (p.action === 'hash') {
      const hash = createHash(p.type.toLowerCase()).update(ev(p.value), 'utf8').digest(p.encoding)
      return { ...item, [p.dataPropertyName]: hash }
    }
    expect(n.credentials.crypto.name).toBe('Marketing trigger secret')
    const mac = createHmac(p.type.toLowerCase(), KEY).update(ev(p.value), 'utf8').digest(p.encoding)
    return { ...item, [p.dataPropertyName]: mac }
  }
  let current = wf.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger').name
  let item = {}
  for (let guard = 0; current && guard < 100; guard++) {
    const n = node(wf, current)
    visited.push(current)
    const proxy = new Proxy(item, {
      get(target, prop) {
        if (typeof prop === 'string' && !(prop in target) && !(OPTIONAL[current] ?? []).includes(prop)) {
          missing.push(`${current}: $json.${prop}`)
        }
        return target[prop]
      },
    })
    const lookup = (name) => ({ last: () => ({ json: outputs[name].at(-1) }) })
    const ev = (value) => {
      if (typeof value !== 'string' || !value.startsWith('=')) return value
      const evalExpr = (expr) =>
        new Function('$json', '$', '$vars', '$now', `return (${expr})`)(
          proxy,
          lookup,
          { MKT_CORE_ORIGIN: ORIGIN },
          'now',
        )
      const whole = /^=\{\{ (.*) \}\}$/s.exec(value)
      if (whole && !whole[1].includes('}}')) return evalExpr(whole[1])
      return value.slice(1).replace(/\{\{ (.*?) \}\}/gs, (_m, expr) => String(evalExpr(expr)))
    }
    let out = item
    let port = 0
    switch (n.type) {
      case 'n8n-nodes-base.set': {
        const made = {}
        for (const a of n.parameters.assignments.assignments) made[a.name] = ev(a.value)
        out = n.parameters.includeOtherFields ? { ...item, ...made } : made
        break
      }
      case 'n8n-nodes-base.crypto':
        out = callCrypto(n, item, ev)
        break
      case 'n8n-nodes-base.if': {
        const c = n.parameters.conditions.conditions[0]
        expect(c.operator).toEqual({ type: 'number', operation: 'lt' })
        port = ev(c.leftValue) < c.rightValue ? 0 : 1
        break
      }
      case 'n8n-nodes-base.httpRequest': {
        const p = n.parameters
        const request = {
          url: ev(p.url),
          body: ev(p.body),
          headers: Object.fromEntries(p.headerParameters.parameters.map((h) => [h.name, ev(h.value)])),
        }
        requests.push(request)
        if (!respond(requests.length)) {
          port = 1
          out = { error: { message: 'Bad gateway' } }
        }
        break
      }
      default:
        break
    }
    outputs[current] = [...(outputs[current] ?? []), out]
    item = out
    current = wf.connections[current]?.main?.[port]?.[0]?.node
  }
  return { missing, requests, visited, outputs }
}

const verify = (request) => {
  expect(request.url.startsWith(ORIGIN)).toBe(true)
  const path = request.url.slice(ORIGIN.length)
  const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]))
  return checkSignature({
    secret: KEY,
    method: 'POST',
    originalUrl: path,
    headers,
    rawBody: Buffer.from(request.body, 'utf8'),
    nowSeconds: Number(headers['x-mkt-timestamp']),
  })
}
const hex = (length) => randomBytes(length).toString('hex').toUpperCase().slice(0, length)

describe('heartbeat data flow', () => {
  it('every $json field an expression reads exists upstream, and the request is one the core accepts', () => {
    const { missing, requests, visited } = simulate(heartbeat.wf, { generated: hex, respond: () => true })
    expect(missing).toEqual([])
    expect(visited).toEqual([
      'Daily 02:30',
      'Build request',
      'Generate nonce',
      'Hash body',
      'Build signing text',
      'Sign text',
      'Call core',
    ])
    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request.url).toBe(ORIGIN + PATH)
    expect(request.body).toBe(BODY)
    expect(verify(request)).toEqual({ ok: true })
    // The signed text the nodes built equals the core's, for the values that were actually used.
    const nonce = request.headers['X-Mkt-Nonce']
    const text = signingText('POST', PATH, request.headers['X-Mkt-Timestamp'], nonce, Buffer.from(BODY))
    expect(request.headers['X-Mkt-Signature']).toBe(sign(KEY, text))
  })

  it.each([64, 128, 256])(
    'the nonce is exactly 64 lowercase hex characters when the generator returns %i characters',
    (length) => {
      const { requests } = simulate(heartbeat.wf, { generated: () => hex(length), respond: () => true })
      expect(requests[0].headers['X-Mkt-Nonce']).toMatch(/^[0-9a-f]{64}$/)
    },
  )

  it('generates at least 64 hex characters under either reading of the length', () => {
    expect(node(heartbeat.wf, 'Generate nonce').parameters.stringLength).toBe(128)
  })

  it('a failed call retries through Build request with a fresh nonce and signature each time', () => {
    const { missing, requests, visited } = simulate(heartbeat.wf, { generated: hex, respond: (n) => n >= 3 })
    expect(missing).toEqual([])
    expect(requests).toHaveLength(3)
    expect(new Set(requests.map((r) => r.headers['X-Mkt-Nonce'])).size).toBe(3)
    expect(new Set(requests.map((r) => r.headers['X-Mkt-Signature'])).size).toBe(3)
    for (const request of requests) expect(verify(request)).toEqual({ ok: true })
    expect(visited.filter((name) => name === 'Wait before retry')).toHaveLength(2)
    expect(visited.at(-1)).toBe('Call core')
  })

  it('gives up after the first try and three retries', () => {
    const { missing, requests, visited } = simulate(heartbeat.wf, { generated: hex, respond: () => false })
    expect(missing).toEqual([])
    expect(requests).toHaveLength(4)
    expect(visited.at(-1)).toBe('Give up')
    expect(visited.filter((name) => name === 'Wait before retry')).toHaveLength(3)
  })

  it('does not hide a failed call: no neverError, no continue-on-fail, error output feeds the retry counter', () => {
    const wf = heartbeat.wf
    const http = node(wf, 'Call core')
    expect(http.parameters.options?.response?.response?.neverError).toBeUndefined()
    expect(JSON.stringify(http.parameters)).not.toMatch(/neverError/i)
    expect(http.continueOnFail).toBeUndefined()
    expect(http.retryOnFail).toBeUndefined()
    expect(http.onError).toBe('continueErrorOutput')
    expect(targets(wf, 'Call core', 0)).toEqual([])
    expect(targets(wf, 'Call core', 1)).toEqual(['Count attempt'])
  })

  it('pins the timestamp expression and the retry limit exactly', () => {
    const wf = heartbeat.wf
    expect(assignment(node(wf, 'Build request'), 'ts').value).toBe(
      '={{ String(Math.floor(Date.now()/1000)) }}',
    )
    const condition = node(wf, 'Retries left?').parameters.conditions.conditions[0]
    expect(condition.rightValue).toBe(4)
    expect(condition.operator).toEqual({ type: 'number', operation: 'lt' })
    expect(condition.leftValue).toBe('={{ $json.attempt }}')
  })
})
