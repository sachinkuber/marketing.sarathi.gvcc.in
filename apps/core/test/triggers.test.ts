import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sign, signingText } from '../src/triggers/signature.ts'
import { TRIGGER_SECRET, createStack, type Stack } from './support.ts'

let stack: Stack
beforeAll(async () => {
  stack = await createStack({ realAudit: true })
})
afterAll(async () => {
  await stack?.close()
})
beforeEach(() => {
  stack.logs.length = 0
})

const PATH = '/api/v1/triggers/ping'
const BODY = '{"workflow":"daily"}'

interface Signed {
  method: string
  path: string
  body: string
  headers: Record<string, string>
}

// The caller n8n is: sign the text of the request as it will be sent.
function signedRequest(
  secret: string,
  options: { method?: string; path?: string; body?: string; timestamp?: number; nonce?: string } = {},
): Signed {
  const method = options.method ?? 'POST'
  const path = options.path ?? PATH
  const body = options.body ?? BODY
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000))
  const nonce = options.nonce ?? randomBytes(32).toString('hex')
  const signature = sign(secret, signingText(method, path, timestamp, nonce, Buffer.from(body)))
  return {
    method,
    path,
    body,
    headers: {
      'content-type': 'application/json',
      'x-mkt-timestamp': timestamp,
      'x-mkt-nonce': nonce,
      'x-mkt-signature': signature,
    },
  }
}

const send = (r: Signed) =>
  fetch(stack.server.url + r.path, { method: r.method, headers: r.headers, body: r.body })

const refusals = () =>
  stack.logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === 'trigger_refused')

async function auditCount(): Promise<number> {
  const r = await stack.db.admin.query(
    "select count(*)::int as n from audit.log where action = 'trigger.received'",
  )
  return r.rows[0].n as number
}

async function expectRefused(r: Signed, reason: string) {
  const before = await auditCount()
  const res = await send(r)
  expect(res.status).toBe(401)
  expect((await res.json()).error.code).toBe('trigger_refused')
  const logged = refusals()
  expect(logged).toHaveLength(1)
  // The reason only: no header, body, secret or signature in the line.
  const { event, reason: why, ...rest } = logged[0] as Record<string, unknown>
  expect(event).toBe('trigger_refused')
  expect(why).toBe(reason)
  expect(Object.keys(rest).sort()).toEqual(['hostname', 'level', 'pid', 'time'])
  const line = stack.logs[0] as string
  for (const secret of [r.headers['x-mkt-signature'], r.headers['x-mkt-nonce'], TRIGGER_SECRET]) {
    if (secret) expect(line).not.toContain(secret)
  }
  expect(await auditCount()).toBe(before)
}

describe('test 33: a signed trigger', () => {
  it('accepts a correct request, audits it on the platform chain as n8n, and logs no refusal', async () => {
    const res = await send(signedRequest(TRIGGER_SECRET))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(refusals()).toHaveLength(0)
    const rows = await stack.db.admin.query(
      "select chain_key, actor_kind, actor_id, outcome, subject, detail from audit.log where action = 'trigger.received'",
    )
    expect(rows.rows).toEqual([
      {
        chain_key: 'platform',
        actor_kind: 'n8n',
        actor_id: null,
        outcome: 'success',
        subject: 'ping',
        detail: { workflow: 'daily' },
      },
    ])
  })

  it('refuses a wrong secret', async () => {
    await expectRefused(signedRequest(TRIGGER_SECRET + 'x'), 'bad_signature')
  })

  it('refuses a body changed by one byte, and one re-serialised with a space', async () => {
    const one = signedRequest(TRIGGER_SECRET)
    await expectRefused({ ...one, body: '{"workflow":"daiLy"}' }, 'bad_signature')
    stack.logs.length = 0
    const two = signedRequest(TRIGGER_SECRET)
    await expectRefused({ ...two, body: '{"workflow": "daily"}' }, 'bad_signature')
  })

  it('refuses a changed path, a changed method, and a timestamp or nonce changed after signing', async () => {
    await expectRefused({ ...signedRequest(TRIGGER_SECRET), path: `${PATH}/` }, 'bad_signature')
    stack.logs.length = 0
    // The signature covers the method: there is no PUT route, and the answer is still 401, not 404.
    const put = signedRequest(TRIGGER_SECRET)
    const res = await send({ ...put, method: 'PUT' })
    expect(res.status).toBe(401)
    stack.logs.length = 0
    const ts = signedRequest(TRIGGER_SECRET)
    await expectRefused(
      {
        ...ts,
        headers: { ...ts.headers, 'x-mkt-timestamp': String(Number(ts.headers['x-mkt-timestamp']) + 1) },
      },
      'bad_signature',
    )
    stack.logs.length = 0
    const nonce = signedRequest(TRIGGER_SECRET)
    const changed = (nonce.headers['x-mkt-nonce'] as string).replace(/.$/, (c) => (c === '0' ? '1' : '0'))
    await expectRefused({ ...nonce, headers: { ...nonce.headers, 'x-mkt-nonce': changed } }, 'bad_signature')
  })

  it('refuses any query string, even a bare question mark', async () => {
    await expectRefused(signedRequest(TRIGGER_SECRET, { path: `${PATH}?a=1` }), 'query_string')
    stack.logs.length = 0
    await expectRefused(signedRequest(TRIGGER_SECRET, { path: `${PATH}?` }), 'query_string')
  })

  it('refuses a timestamp 301 seconds old or ahead, and accepts 299 seconds old', async () => {
    const now = Math.floor(Date.now() / 1000)
    await expectRefused(signedRequest(TRIGGER_SECRET, { timestamp: now - 301 }), 'stale')
    stack.logs.length = 0
    await expectRefused(signedRequest(TRIGGER_SECRET, { timestamp: now + 301 }), 'stale')
    stack.logs.length = 0
    expect((await send(signedRequest(TRIGGER_SECRET, { timestamp: now - 299 }))).status).toBe(200)
  })

  it('refuses the same nonce twice: the second answer is replayed', async () => {
    const nonce = randomBytes(32).toString('hex')
    expect((await send(signedRequest(TRIGGER_SECRET, { nonce }))).status).toBe(200)
    await expectRefused(signedRequest(TRIGGER_SECRET, { nonce }), 'replayed')
  })

  it('refuses a 63-character nonce', async () => {
    await expectRefused(
      signedRequest(TRIGGER_SECRET, { nonce: randomBytes(32).toString('hex').slice(1) }),
      'bad_nonce',
    )
  })

  it('refuses a missing header, each in turn', async () => {
    for (const name of ['x-mkt-timestamp', 'x-mkt-nonce', 'x-mkt-signature']) {
      stack.logs.length = 0
      const r = signedRequest(TRIGGER_SECRET)
      const headers = { ...r.headers }
      delete headers[name]
      const before = await auditCount()
      const res = await send({ ...r, headers })
      // Without x-mkt-signature the guard does not exempt the call, so it stops there at the origin check.
      expect(res.status).toBe(name === 'x-mkt-signature' ? 403 : 401)
      if (name !== 'x-mkt-signature') {
        expect(refusals().map((e) => e.reason)).toEqual(['missing_header'])
      }
      expect(await auditCount()).toBe(before)
    }
  })

  it('refuses a signature of the wrong length with 401, not an error', async () => {
    const r = signedRequest(TRIGGER_SECRET)
    await expectRefused({ ...r, headers: { ...r.headers, 'x-mkt-signature': 'abcd' } }, 'bad_signature')
  })

  it('does not record the nonce of a request that failed the signature', async () => {
    const nonce = randomBytes(32).toString('hex')
    await send(signedRequest(TRIGGER_SECRET + 'x', { nonce }))
    const row = await stack.db.admin.query(
      "select 1 from app.trigger_nonce where nonce = decode($1, 'hex')",
      [nonce],
    )
    expect(row.rowCount).toBe(0)
  })

  it('refuses a signed body that is not the ping shape, after the signature check', async () => {
    const res = await send(signedRequest(TRIGGER_SECRET, { body: '{"workflow":"daily","extra":1}' }))
    expect(res.status).toBe(400)
    const bad = await send(signedRequest(TRIGGER_SECRET, { body: 'not json' }))
    expect(bad.status).toBe(400)
  })

  it('refuses a body over 16 kB', async () => {
    const res = await send(
      signedRequest(TRIGGER_SECRET, { body: JSON.stringify({ workflow: 'x'.repeat(20000) }) }),
    )
    expect(res.status).toBe(413)
  })
})

describe('test 34: nonce clean-up and the stale check before the replay check', () => {
  it('removes a nonce older than ten minutes on the next accepted request; its old replay is stale', async () => {
    const old = randomBytes(32).toString('hex')
    await stack.db.admin.query(
      "insert into app.trigger_nonce (nonce, received_at) values (decode($1, 'hex'), now() - interval '11 minutes')",
      [old],
    )
    const oldRequest = signedRequest(TRIGGER_SECRET, {
      nonce: old,
      timestamp: Math.floor(Date.now() / 1000) - 11 * 60,
    })
    expect((await send(signedRequest(TRIGGER_SECRET))).status).toBe(200)
    const left = await stack.db.admin.query(
      "select 1 from app.trigger_nonce where nonce = decode($1, 'hex')",
      [old],
    )
    expect(left.rowCount).toBe(0)
    stack.logs.length = 0
    await expectRefused(oldRequest, 'stale')
  })
})
