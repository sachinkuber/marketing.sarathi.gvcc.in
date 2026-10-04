import type { Express } from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createPool, type Pool } from '@mkt/db'
import { createTestDatabase, type TestDatabase } from '@mkt/db/testing'
import { requireDatabase } from '@mkt/test-support'
import type { Config } from '../src/config.ts'
import { buildCore } from '../src/core.ts'
import { createLogger } from '../src/logger.ts'
import { createUserWithPassword } from '../src/auth/users.ts'
import type { Role } from '../src/auth/session.ts'
import type { MailMessage } from '../src/ports.ts'
import { MemoryAudit, MemoryMailer } from '../src/testing.ts'

export interface TestServer {
  url: string
  close(): Promise<void>
}

export async function startTestServer(app: Express): Promise<TestServer> {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}

export const ORIGIN = 'https://app.example.test'

export interface Stack {
  db: TestDatabase
  appPool: Pool
  authPool: Pool
  mailer: MemoryMailer
  audit: MemoryAudit
  core: ReturnType<typeof buildCore>
  server: TestServer
  newClient(): TestClient
  close(): Promise<void>
}

export async function createStack(): Promise<Stack> {
  await requireDatabase()
  const db = await createTestDatabase()
  const appPool = createPool(db.urlFor('app'))
  const authPool = createPool(db.urlFor('app'), { searchPath: 'auth' })
  const mailer = new MemoryMailer()
  const audit = new MemoryAudit()
  const config: Config = {
    nodeEnv: 'test',
    port: 0,
    databaseUrl: db.urlFor('app'),
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    publicOrigin: ORIGIN,
    logLevel: 'silent',
  }
  const core = buildCore({ config, logger: createLogger('silent'), appPool, authPool, mailer, audit })
  const server = await startTestServer(core.app)
  return {
    db,
    appPool,
    authPool,
    mailer,
    audit,
    core,
    server,
    newClient: () => new TestClient(server.url, ORIGIN),
    async close() {
      await server.close()
      await appPool.end()
      await authPool.end()
      await db.drop()
    },
  }
}

export async function addBrand(stack: Stack, slug: string): Promise<string> {
  const result = await stack.db.admin.query('select app.create_brand($1, $1) as id', [slug])
  return result.rows[0].id as string
}

export async function addUser(
  stack: Stack,
  options: { email: string; password: string; role?: Role; brandId?: string; platformOwner?: boolean },
): Promise<string> {
  const { id } = await createUserWithPassword(stack.core.auth, {
    email: options.email,
    name: options.email.split('@')[0] ?? 'user',
    password: options.password,
  })
  if (options.brandId && options.role) {
    await stack.db.admin.query('insert into app.membership (brand_id, user_id, role) values ($1, $2, $3)', [
      options.brandId,
      id,
      options.role,
    ])
  }
  if (options.platformOwner) {
    await stack.db.admin.query('insert into app.platform_owner (user_id) values ($1)', [id])
  }
  return id
}

export interface Reply {
  status: number
  // Test replies are read loosely on purpose.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any
  text: string
  headers: Headers
  setCookies: string[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJson(text: string): any {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

export class TestClient {
  private readonly cookies = new Map<string, string>()
  csrf: string | null = null
  private readonly base: string
  private readonly origin: string

  constructor(base: string, origin: string) {
    this.base = base
    this.origin = origin
  }

  async request(
    method: string,
    path: string,
    options: {
      body?: unknown
      origin?: string | null
      csrf?: boolean
      headers?: Record<string, string>
    } = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = { ...options.headers }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const origin = options.origin === undefined ? this.origin : options.origin
    if (origin) headers.origin = origin
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    }
    if (options.csrf !== false && this.csrf) headers['x-csrf-token'] = this.csrf
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
    })
    const setCookies = res.headers.getSetCookie()
    for (const line of setCookies) {
      const pair = line.split(';')[0] ?? ''
      const at = pair.indexOf('=')
      const name = pair.slice(0, at)
      const value = pair.slice(at + 1)
      if (value === '' || /;\s*Max-Age=0/i.test(line)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    const text = await res.text()
    return { status: res.status, json: parseJson(text), text, headers: res.headers, setCookies }
  }

  async refreshCsrf(): Promise<Reply> {
    const reply = await this.request('GET', '/api/v1/session')
    this.csrf = reply.json?.csrfToken ?? null
    return reply
  }

  // Signs in. If no second factor is asked for, the session token for later writes is fetched too.
  async signIn(email: string, password: string): Promise<Reply> {
    const reply = await this.request('POST', '/api/auth/sign-in/email', { body: { email, password } })
    if (reply.status === 200 && !reply.json?.twoFactorRedirect) await this.refreshCsrf()
    return reply
  }
}

export function tokenFromMail(message: MailMessage): string {
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(message.text)
  if (!match) throw new Error('no token in the message')
  return match[1] as string
}
