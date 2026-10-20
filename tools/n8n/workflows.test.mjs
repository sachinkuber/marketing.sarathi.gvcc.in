import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sign, signingText } from '../../apps/core/src/triggers/signature.ts'

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
    expect(JSON.stringify(wf.nodes.find((n) => n.name === 'Retries left?').parameters)).toContain('4')
  })

  it('the text node template is the five-line signed format, and matches the core for fixed values', () => {
    const build = node(heartbeat.wf, 'Build signing text')
    const template = assignment(build, 'text').value
    expect(template).toBe('=POST\n{{ $json.path }}\n{{ $json.ts }}\n{{ $json.nonce }}\n{{ $json.bodyHash }}')

    // Fixed test values, run through what each n8n node does.
    const ts = '1760000000'
    const nonce = 'ab'.repeat(32)
    const body = '{"workflow":"marketing-daily-heartbeat"}'
    const path = '/api/v1/triggers/daily'
    const key = 'fixed-test-key-not-a-real-one'

    // Crypto "Hash body": SHA-256, hex, of the body string.
    const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex')
    // Set "Build signing text": substitute each {{ $json.x }} into the template.
    const fields = { path, ts, nonce, bodyHash }
    const text = template.slice(1).replace(/\{\{ \$json\.(\w+) \}\}/g, (_m, k) => fields[k])
    // Crypto "Sign text": HMAC-SHA256, hex, of that text under the credential's key.
    const n8nSignature = createHmac('sha256', key).update(text, 'utf8').digest('hex')

    const coreText = signingText('POST', path, ts, nonce, Buffer.from(body, 'utf8'))
    expect(text).toBe(coreText)
    expect(text.split('\n')).toHaveLength(5)
    expect(n8nSignature).toBe(sign(key, coreText))
    expect(n8nSignature).toMatch(/^[0-9a-f]{64}$/)
  })
})
