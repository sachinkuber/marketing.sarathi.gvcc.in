import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SESSION_IDLE_SECONDS, SESSION_REFRESH_SECONDS } from '../src/auth/policy.ts'
import { addBrand, addUser, createStack, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'

// Spec 7: a session ends after 30 idle minutes, so activity on the service's own routes must slide both
// the stored expiry and the browser's cookie. The library refreshes once the session is more than
// SESSION_REFRESH_SECONDS old, judged from expiresAt.
describe('the idle timeout slides with activity on the service routes', () => {
  let stack: Stack

  beforeAll(async () => {
    stack = await createStack()
    stack.core.api.post('/test-touch', (_req, res) => {
      res.json({ ok: true })
    })
    const brand = await addBrand(stack, 'brand-a')
    await addUser(stack, { email: 'viewer@example.test', password: PASSWORD, role: 'viewer', brandId: brand })
  })
  afterAll(async () => stack?.close())

  // A signed-in viewer (no second factor needed) whose session was last refreshed six minutes ago.
  async function staleSession(): Promise<{ client: TestClient; id: string }> {
    const client = stack.newClient()
    expect((await client.signIn('viewer@example.test', PASSWORD)).status).toBe(200)
    const rows = await stack.db.admin.query(
      `update auth.session set "expiresAt" = now() + make_interval(secs => $1)
        where id = (select id from auth.session order by "createdAt" desc limit 1) returning id`,
      [SESSION_IDLE_SECONDS - SESSION_REFRESH_SECONDS - 60],
    )
    return { client, id: rows.rows[0].id as string }
  }

  async function expectSlid(reply: { setCookies: string[] }, id: string): Promise<void> {
    const cookie = reply.setCookies.find((line) => /session_token=[^;]+/.test(line))
    expect(cookie, 'a renewed session cookie').toBeDefined()
    expect(cookie).toMatch(new RegExp(`Max-Age=${SESSION_IDLE_SECONDS}`, 'i'))
    const row = await stack.db.admin.query(
      'select extract(epoch from ("expiresAt" - now())) as left from auth.session where id = $1',
      [id],
    )
    expect(Number(row.rows[0].left)).toBeGreaterThan(SESSION_IDLE_SECONDS - 30)
  }

  it('GET /api/v1/session renews the cookie and the stored expiry', async () => {
    const { client, id } = await staleSession()
    const reply = await client.request('GET', '/api/v1/session')
    expect(reply.status).toBe(200)
    await expectSlid(reply, id)
  })

  it('a state-changing request behind the gate renews them too', async () => {
    const { client, id } = await staleSession()
    const reply = await client.request('POST', '/api/v1/test-touch', { body: {} })
    expect(reply.status).toBe(200)
    await expectSlid(reply, id)
  })

  it('a fresh session is not re-issued on every request', async () => {
    const client = stack.newClient()
    await client.signIn('viewer@example.test', PASSWORD)
    const reply = await client.request('GET', '/api/v1/session')
    expect(reply.setCookies.filter((line) => /session_token/.test(line))).toEqual([])
  })
})
