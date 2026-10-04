# Milestone 2b (Core service and sign-in) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A core service that starts, validates every input, logs without leaking, refuses cross-site requests, and lets an invited person set a password, enrol an authenticator app, sign in with a second factor, recover a password and sign out, with the first reachable screen after sign-in gated on enrolment.

**Architecture:** One new app, `apps/core` (Express 5), built from small modules: configuration, logger, error and validation helpers, a request guard, and an auth module that wraps Better Auth. Better Auth's tables live in the `auth` schema, created by a numbered migration whose SQL is produced once by the library's own `getMigrations(...).compileMigrations()` and reviewed. Invites are redeemed by named database functions, because the person is not yet a member of any brand. Email and the audit log are ports with in-memory test doubles, because their real implementations belong to packages 11 and 6.

**Tech Stack:** Node 24.20.0, TypeScript 5.9.3, Express 5.2.1, helmet 8.3.0, Zod 4.5.4, pino 10.3.1 with pino-http 11.0.0, Better Auth 1.7.2 with its two-factor plugin, pg 8.23.0 through `@mkt/db`, PostgreSQL 17.11, Vitest 4.1.11. No new dependency is added.

**Spec:** `docs/specs/2026-10-04-phase-1-foundation.md` (version 5) sections 3, 5 (membership, invite), 6, 7, 8 and 18 (packages 3 and 4). Roles: PRD 16.1. Sign-in flows: `docs/app-flow/2026-10-04-app-flow.md` sections 5.1 and 5.2. Auth tables: `docs/database/2026-10-04-database-schema.md` sections 4, 5.2 to 5.4. Acceptance tests proven here: 8, 9, 10, 11 and 12 (test 8 through the API gate; the screen itself arrives with the dashboard). Test 13 (every route declares a permission) is package 5. Test 1 (every API operation refuses brand B's records) needs the content routes of later milestones.

## Scope

In this plan: packages 3 and 4, which are the HTTP shell, the sign-in schema, the second factor, backup codes, invites (creating one as a service function, accepting one as a route), password recovery, sessions, lockout and the cross-site guard.

Not in this plan, and why:

- **Users admin routes** (list, change role, remove, reset a second factor, the HTTP route that creates an invite) and the "ask for the second factor again before a sensitive action" rule. They are permission-gated, so they belong with package 5 and its route-declaration test.
- **Real email delivery** (Nodemailer) and the notification tables: package 11. Here `Mailer` is a port.
- **The audit log tables and hash chain**: package 6. Here `AuditSink` is a port, and sign-in events go to it.
- **Passkeys**: later (spec section 3).

The enrolment gate covers the service's own routes under `/api/v1`. The sign-in library's routes under `/api/auth` (change password, list sessions and so on) act only on the signed-in person's own account, so they stay reachable before enrolment, as the enrolment routes themselves must be.

## Global Constraints

- Everything from the milestone 1 and 2a plans still holds: exact pins, committed lockfile, no secret committed, n8n untouched, nothing installed on the owner's laptop, no server address written into the repository (write `root@<dev-server>`).
- Every command marked "Run (server)" is run like this, from the repository root on the laptop: `rsync -rc --exclude node_modules --exclude .git --exclude .superpowers ./ root@<dev-server>:/opt/mkt-dev/marketing/` and then `ssh root@<dev-server> '/opt/mkt-dev/run.sh "<command>"'`. The database container `mkt-dev-postgres-1` must be up (`docker compose -f infra/dev/compose.yaml up -d --wait` on the server). After any command that changes `package-lock.json`, copy it back with `rsync root@<dev-server>:/opt/mkt-dev/marketing/package-lock.json ./`.
- Domain used for development and staging: `stg.marketing.sarathi.gvcc.in` (owner, 2026-10-04). Tests use `https://app.example.test` and never the real domain.
- Sign-in is email and password, then an authenticator-app code. Viewer signs in with email and password only. Enrolment is forced at first sign-in for every role except Viewer, and until it is complete only the enrolment routes are reachable (SEC-1). No self-registration.
- An invite is single-use, expires after 72 hours, and only its hash is stored.
- Password recovery: a single-use emailed link that expires after 30 minutes. Resetting a password never skips the second factor, and it ends all of that user's sessions.
- Backup codes are shown once at enrolment, each is usable once, and using one is audited and notified to the user.
- Sessions are server-side, in a secure, same-site cookie, with an idle timeout.
- Cross-site request protection: same-site cookies, an origin check on every state-changing request, and a per-session token the dashboard must send. A request missing any of these is refused.
- Rate limits and lockout on sign-in, recovery and invite acceptance. Each attempt is audited.
- The sign-in library's tables live in the `auth` schema. Their SQL is generated once, reviewed and committed as a numbered migration. The library's own `migrate` is never run. The application role cannot create or alter tables. We add no column to the library's tables.
- All inputs are validated against a strict schema. All brand data access passes through `withBrand`. Application code never imports `pg`, `kysely` or `pg-boss` (the lint rule from milestone 2a already covers `apps/**`).
- Source files run under Node's type stripping, so use no enums and no constructor parameter properties.

## Values proposed in this plan

The spec says "idle timeout", "lockout" and so on without figures. These are proposals, kept in one file (`apps/core/src/auth/policy.ts`) so they can be changed in one place. The owner confirms them in review.

| Setting | Proposed value |
|---|---|
| Minimum / maximum password length | 12 / 128 characters |
| Session idle timeout; refresh after activity | 30 minutes; 5 minutes |
| Lockout | 5 failures within 15 minutes lock that key for 15 minutes |
| Backup codes issued at enrolment | 10, each 10 characters |

## Decisions the owner confirmed (all five accepted, 2026-10-04)

1. **Lockout is held in the process's memory.** It resets when the core service restarts. A lockout that survives restarts needs a table that the database schema document does not have. Proposed: accept this in phase 1.
2. **An invite to an email that already has an account is refused at acceptance** (409). Adding an existing user to a second brand needs a "sign in first" flow that the app-flow document does not describe. Proposed: out of phase 1; the first two brands each have their own users.
3. **Eight foreign keys to `auth.user` are added in migration 0006**, the columns the schema document says reference it: `platform_owner` (`user_id`, `granted_by`), `membership` (`user_id`, `created_by`), `invite` (`invited_by`), `approval_setting` (`updated_by`), `approval` (`decided_by`), `approval_request` (`escalated_to`). Columns such as `kill_switch.set_by` stay plain `uuid`, as the schema document leaves them.
4. **Two ports stand in for later packages.** Until packages 6 and 11, the running service uses a mailer that refuses to send (`UnconfiguredMailer`) and an audit sink that writes to the log (`LogAudit`). No real invite or recovery email can be sent until package 11.
5. **Audit entries hold a hash of the email address, not the address**, because the audit log is insert-only and cannot be erased.

## Review Focus

1. **A state-changing request with no `Origin` header** (a script, `curl`, a non-browser client) is refused, not waved through. Task 3.
2. **A user who needs a second factor but has no memberships**, or is a Viewer in one brand and an approver in another, or is a platform owner with no brand, must be treated as needing one. Only a user whose every membership is Viewer is exempt. Task 5.
3. **Two people (or one double click) accepting the same invite at once** produce exactly one account and one membership, and the invite is never left half used. Task 6.
4. **Turning the second factor off through the library's own `two-factor/disable` route** must be refused for everyone. SEC-1 says there is no way to turn it off for a single user. Task 7.
5. **Asking for a password reset for an address that has no account** must look identical to asking for one that does: same status, same body, no email sent. Likewise, wrong email and wrong password give the same sign-in error. Task 8.
6. **The same address typed with different capitals** shares one lockout, and an address that has no account locks out too, so lockout cannot be used to find out who has an account. Task 9.
7. **A password, a reset token, a cookie or a code reaching the log**, including from a failed request or an error. Tasks 1, 2 and 9.

---

### Task 1: Workspace wiring, configuration and the logger

**Files:**

- Modify: `package.json` (workspaces), `tsconfig.json` (include), `vitest.config.ts` (include)
- Create: `packages/db/src/pool.ts`; modify `packages/db/src/index.ts`
- Create: `apps/core/package.json`, `apps/core/src/config.ts`, `apps/core/src/logger.ts`
- Test: `packages/db/test/pool.test.ts`, `apps/core/test/config.test.ts`, `apps/core/test/logger.test.ts`

**Interfaces:**

- Consumes: `createTestDatabase` from `@mkt/db/testing`; `requireDatabase` from `@mkt/test-support`
- Produces:
  - `createPool(connectionString: string, options?: { searchPath?: string; max?: number }): Pool` and the types `Pool`, `PoolClient`, all from `@mkt/db`
  - `loadConfig(env: Record<string, string | undefined>): Config` where `Config = { nodeEnv: 'development' | 'test' | 'production'; port: number; databaseUrl: string; authSecret: string; publicOrigin: string; logLevel: LevelWithSilent }`
  - `createLogger(level: LevelWithSilent, destination?: DestinationStream): Logger` from `apps/core/src/logger.ts`

- [ ] **Step 1: Write the failing tests**

`packages/db/test/pool.test.ts`:

```ts
import { requireDatabase } from '@mkt/test-support'
import { describe, expect, it } from 'vitest'
import { createPool } from '../src/pool.ts'
import { createTestDatabase } from '../src/testing.ts'

describe('createPool', () => {
  it('starts every connection with the given search path', async () => {
    await requireDatabase()
    const db = await createTestDatabase()
    const pool = createPool(db.urlFor('app'), { searchPath: 'auth' })
    try {
      const result = await pool.query('show search_path')
      expect(result.rows[0].search_path).toBe('auth')
    } finally {
      await pool.end()
      await db.drop()
    }
  })

  it('leaves the search path alone when none is given', async () => {
    await requireDatabase()
    const db = await createTestDatabase()
    const pool = createPool(db.urlFor('app'))
    try {
      const result = await pool.query('show search_path')
      expect(result.rows[0].search_path).not.toContain('auth')
    } finally {
      await pool.end()
      await db.drop()
    }
  })
})
```

`apps/core/test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

const base = {
  DATABASE_URL: 'postgres://app:pw@127.0.0.1:5432/mkt',
  AUTH_SECRET: 'a'.repeat(32),
  PUBLIC_ORIGIN: 'https://app.example.test',
}

describe('loadConfig', () => {
  it('applies defaults and ignores unrelated variables', () => {
    const config = loadConfig({ ...base, PATH: '/usr/bin', HOME: '/root' })
    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 4000,
      logLevel: 'info',
      publicOrigin: 'https://app.example.test',
    })
  })

  it('reduces the public origin to scheme, host and port', () => {
    const config = loadConfig({ ...base, PUBLIC_ORIGIN: 'https://app.example.test/some/path/' })
    expect(config.publicOrigin).toBe('https://app.example.test')
  })

  it('names every bad variable and prints no value', () => {
    const secret = 'short-secret'
    let message = ''
    try {
      loadConfig({ AUTH_SECRET: secret, PUBLIC_ORIGIN: 'not a url' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('DATABASE_URL')
    expect(message).toContain('AUTH_SECRET')
    expect(message).toContain('PUBLIC_ORIGIN')
    expect(message).not.toContain(secret)
  })
})
```

`apps/core/test/logger.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createLogger } from '../src/logger.ts'

function capture() {
  const lines: string[] = []
  return {
    lines,
    stream: {
      write: (line: string) => {
        lines.push(line)
      },
    },
  }
}

describe('logger redaction', () => {
  it('replaces secrets at the top level and one level down', () => {
    const { lines, stream } = capture()
    const log = createLogger('info', stream)
    log.info(
      {
        password: 'hunter2',
        body: { newPassword: 'hunter3', code: '123456', totpURI: 'otpauth://totp/x?secret=ABCDEF' },
        req: { headers: { cookie: 'sid=abc', authorization: 'Bearer t0k', 'x-csrf-token': 'csrf-value' } },
      },
      'a request',
    )
    const out = lines.join('')
    for (const secret of ['hunter2', 'hunter3', '123456', 'ABCDEF', 'sid=abc', 'Bearer t0k', 'csrf-value']) {
      expect(out).not.toContain(secret)
    }
    expect(out).toContain('[Redacted]')
  })

  it('keeps ordinary fields', () => {
    const { lines, stream } = capture()
    createLogger('info', stream).info({ route: '/health/live', status: 200 }, 'ok')
    expect(lines.join('')).toContain('/health/live')
  })
})
```

- [ ] **Step 2: Wire the workspace and create the package file**

In `package.json` set `"workspaces": ["apps/*", "packages/*"]`.

In `tsconfig.json` set:

```json
"include": [
  "apps/*/src/**/*.ts",
  "apps/*/test/**/*.ts",
  "packages/*/src/**/*.ts",
  "packages/*/test/**/*.ts",
  "vitest.config.ts"
]
```

In `vitest.config.ts` set `include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'tools/**/*.test.mjs']`.

`apps/core/package.json`:

```json
{
  "name": "@mkt/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@mkt/db": "*",
    "better-auth": "1.7.2",
    "express": "5.2.1",
    "helmet": "8.3.0",
    "pino": "10.3.1",
    "pino-http": "11.0.0",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "@mkt/test-support": "*",
    "@types/express": "5.0.6"
  }
}
```

Run (server): `npm install`. Expected: succeeds, and `package-lock.json` gains the `apps/core` workspace. Copy the lockfile back. Then Run (server): `npx vitest run packages/db/test/pool.test.ts apps/core`. Expected: FAIL, the three source files do not exist.

- [ ] **Step 3: Write the pool helper**

`packages/db/src/pool.ts`:

```ts
import pg from 'pg'

export interface PoolOptions {
  searchPath?: string
  max?: number
}

// The only place a connection pool is made, so application code never imports pg itself.
export function createPool(connectionString: string, options: PoolOptions = {}): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
  })
}
```

Replace `packages/db/src/index.ts` with:

```ts
export { migrate } from './migrate.ts'
export { createPool } from './pool.ts'
export type { PoolOptions } from './pool.ts'
export { withBrand } from './with-brand.ts'
export type { Pool, PoolClient } from 'pg'
```

- [ ] **Step 4: Write the configuration and the logger**

`apps/core/src/config.ts`:

```ts
import { z } from 'zod'

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url(),
  AUTH_SECRET: z.string().min(32),
  PUBLIC_ORIGIN: z.url(),
  LOG_LEVEL: z.enum(LEVELS).default('info'),
})

export interface Config {
  nodeEnv: 'development' | 'test' | 'production'
  port: number
  databaseUrl: string
  authSecret: string
  publicOrigin: string
  logLevel: (typeof LEVELS)[number]
}

// Reads only the variables the service knows. A failure names the variables and never prints a value.
export function loadConfig(env: Record<string, string | undefined>): Config {
  const picked: Record<string, string> = {}
  for (const key of Object.keys(schema.shape)) {
    const value = env[key]
    if (value !== undefined) picked[key] = value
  }
  const parsed = schema.safeParse(picked)
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))]
    throw new Error(`Invalid configuration: ${names.join(', ')}`)
  }
  const value = parsed.data
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    authSecret: value.AUTH_SECRET,
    publicOrigin: new URL(value.PUBLIC_ORIGIN).origin,
    logLevel: value.LOG_LEVEL,
  }
}
```

`apps/core/src/logger.ts`:

```ts
import { pino, type DestinationStream, type LevelWithSilent, type Logger } from 'pino'

export const REDACTED_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'code',
  'backupCode',
  'backupCodes',
  'secret',
  'totpURI',
  'authorization',
  'cookie',
]

const paths = [
  ...REDACTED_KEYS,
  ...REDACTED_KEYS.map((key) => `*.${key}`),
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
]

export function createLogger(level: LevelWithSilent, destination?: DestinationStream): Logger {
  return pino({ level, redact: { paths, censor: '[Redacted]' } }, destination)
}
```

- [ ] **Step 5: Run to verify they pass**

Run (server): `npx vitest run packages/db/test/pool.test.ts apps/core`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`
Expected: all pass. Run `npx prettier --write` on any file it names, then copy the file back.

```
git add package.json package-lock.json tsconfig.json vitest.config.ts packages/db apps
git commit -m "feat(core): workspace for apps, pool helper, configuration and a redacting logger"
```

---

### Task 2: The service shell: errors, validation, health

**Files:**

- Create: `apps/core/src/errors.ts`, `apps/core/src/validate.ts`, `apps/core/src/health.ts`, `apps/core/src/app.ts`
- Create: `apps/core/test/support.ts`
- Test: `apps/core/test/health.test.ts`, `apps/core/test/shell.test.ts`

**Interfaces:**

- Consumes: `createLogger` (Task 1)
- Produces:
  - `AppError(status: number, code: string, message: string, details?: unknown)`; `notFoundHandler`; `errorHandler(logger): ErrorRequestHandler`. Error body: `{ error: { code, message, details? } }`.
  - `validate(schemas: { params?; query?; body? }): RequestHandler`. It stores the parsed values in `res.locals.input`; `inputOf<T>(res): T` reads them.
  - `createApp(deps: AppDeps): Express` where `AppDeps = { logger: Logger; ready: () => Promise<void>; now?: () => Date; trustProxy?: number; guard?: RequestHandler; authHandler?: RequestHandler; api?: Router }`. Order of use: security headers, request log, `/health`, `guard` on `/api`, `authHandler` on `/api/auth/*splat` (before the JSON parser, because the auth library reads the raw body), the JSON parser, `api` on `/api/v1`, not-found, error handler.
  - `startTestServer(app): Promise<{ url: string; close(): Promise<void> }>` from `apps/core/test/support.ts`

- [ ] **Step 1: Write the failing tests**

`apps/core/test/support.ts`:

```ts
import type { Express } from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

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
```

`apps/core/test/health.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { createLogger } from '../src/logger.ts'
import { startTestServer, type TestServer } from './support.ts'

const logger = createLogger('silent')
let server: TestServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('health endpoints', () => {
  it('answers liveness without touching the database', async () => {
    let calls = 0
    server = await startTestServer(
      createApp({
        logger,
        ready: async () => {
          calls++
        },
      }),
    )
    const res = await fetch(`${server.url}/health/live`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(calls).toBe(0)
  })

  it('answers readiness 200 when the check passes', async () => {
    server = await startTestServer(createApp({ logger, ready: async () => undefined }))
    const res = await fetch(`${server.url}/health/ready`)
    expect(res.status).toBe(200)
  })

  it('answers readiness 503 with no detail when the check fails', async () => {
    server = await startTestServer(
      createApp({
        logger,
        ready: async () => {
          throw new Error('connect ECONNREFUSED 10.0.0.5:5432')
        },
      }),
    )
    const res = await fetch(`${server.url}/health/ready`)
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ status: 'unavailable' })
    expect(text).not.toContain('ECONNREFUSED')
  })

  it('answers the heartbeat with the current time', async () => {
    server = await startTestServer(
      createApp({
        logger,
        ready: async () => undefined,
        now: () => new Date('2026-10-04T12:00:00.000Z'),
      }),
    )
    const res = await fetch(`${server.url}/health/heartbeat`)
    expect(await res.json()).toEqual({ status: 'ok', at: '2026-10-04T12:00:00.000Z' })
  })
})
```

`apps/core/test/shell.test.ts`:

```ts
import { Router } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createApp } from '../src/app.ts'
import { AppError } from '../src/errors.ts'
import { createLogger } from '../src/logger.ts'
import { validate } from '../src/validate.ts'
import { startTestServer, type TestServer } from './support.ts'

const ID = '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b'

function buildApi() {
  const api = Router()
  api.get('/boom', () => {
    throw new Error('database password is hunter2')
  })
  api.get('/conflict', () => {
    throw new AppError(409, 'conflict', 'Already there.')
  })
  api.post(
    '/echo',
    validate({ body: z.strictObject({ name: z.string().min(1) }) }),
    (_req, res) => {
      res.json(res.locals.input.body)
    },
  )
  api.get(
    '/items/:id',
    validate({
      params: z.strictObject({ id: z.uuid() }),
      query: z.strictObject({ page: z.coerce.number().int().min(1).default(1) }),
    }),
    (_req, res) => {
      res.json(res.locals.input)
    },
  )
  return api
}

let server: TestServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

async function start(lines: string[] = []) {
  const logger = createLogger('info', { write: (line: string) => void lines.push(line) })
  server = await startTestServer(createApp({ logger, ready: async () => undefined, api: buildApi() }))
  return server.url
}

describe('the service shell', () => {
  it('answers an unexpected error with a fixed message and no detail', async () => {
    const url = await start()
    const res = await fetch(`${url}/api/v1/boom`)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: { code: 'internal_error', message: 'Something went wrong.' } })
    expect(text).not.toContain('hunter2')
  })

  it('answers an application error with its own status and code', async () => {
    const url = await start()
    const res = await fetch(`${url}/api/v1/conflict`)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: { code: 'conflict', message: 'Already there.' } })
  })

  it('answers an unknown address with 404 in the same shape', async () => {
    const url = await start()
    const res = await fetch(`${url}/api/v1/nothing-here`)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('not_found')
  })

  it('refuses a body that is not JSON, and a body that is too large', async () => {
    const url = await start()
    const bad = await fetch(`${url}/api/v1/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe('invalid_json')
    const big = await fetch(`${url}/api/v1/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(200_000) }),
    })
    expect(big.status).toBe(413)
    expect((await big.json()).error.code).toBe('payload_too_large')
  })

  it('accepts a valid body and refuses an unknown field', async () => {
    const url = await start()
    const post = (body: unknown) =>
      fetch(`${url}/api/v1/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const ok = await post({ name: 'Aztek' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ name: 'Aztek' })
    const extra = await post({ name: 'Aztek', colour: 'red' })
    expect(extra.status).toBe(400)
    const json = await extra.json()
    expect(json.error.code).toBe('invalid_request')
    expect(JSON.stringify(json.error.details)).toContain('colour')
  })

  it('validates path and query parts and applies defaults', async () => {
    const url = await start()
    const ok = await fetch(`${url}/api/v1/items/${ID}`)
    expect((await ok.json()).query.page).toBe(1)
    expect((await fetch(`${url}/api/v1/items/not-a-uuid`)).status).toBe(400)
    expect((await fetch(`${url}/api/v1/items/${ID}?page=0`)).status).toBe(400)
    expect((await fetch(`${url}/api/v1/items/${ID}?extra=1`)).status).toBe(400)
  })

  it('sets security headers, hides the framework and returns a request ID', async () => {
    const url = await start()
    const res = await fetch(`${url}/health/live`)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-powered-by')).toBeNull()
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('logs the path without its query string, and hides tokens in paths', async () => {
    const lines: string[] = []
    const url = await start(lines)
    await fetch(`${url}/api/v1/items/${ID}?page=2&token=abc123`)
    await fetch(`${url}/api/auth/reset-password/secret-reset-token`)
    await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(2))
    const out = lines.join('')
    expect(out).toContain(`/api/v1/items/${ID}`)
    expect(out).not.toContain('page=2')
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('secret-reset-token')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run (server): `npx vitest run apps/core/test/health.test.ts apps/core/test/shell.test.ts`
Expected: FAIL, `../src/app.ts` does not exist.

- [ ] **Step 3: Write the helpers**

`apps/core/src/errors.ts`:

```ts
import type { ErrorRequestHandler, RequestHandler, Response } from 'express'
import type { Logger } from 'pino'

export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function send(res: Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } })
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  send(res, 404, 'not_found', 'There is nothing at this address.')
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err)
      return
    }
    if (err instanceof AppError) {
      send(res, err.status, err.code, err.message, err.details)
      return
    }
    const type = (err as { type?: string }).type
    if (type === 'entity.parse.failed') {
      send(res, 400, 'invalid_json', 'The request body is not valid JSON.')
      return
    }
    if (type === 'entity.too.large') {
      send(res, 413, 'payload_too_large', 'The request body is too large.')
      return
    }
    logger.error({ err, requestId: req.id }, 'unhandled error')
    send(res, 500, 'internal_error', 'Something went wrong.')
  }
}
```

`apps/core/src/validate.ts`:

```ts
import type { RequestHandler, Response } from 'express'
import type { z } from 'zod'
import { AppError } from './errors.ts'

interface Schemas {
  params?: z.ZodType
  query?: z.ZodType
  body?: z.ZodType
}

// Every schema passed here is written with z.strictObject, so an unknown field is an error.
export function validate(schemas: Schemas): RequestHandler {
  return (req, res, next) => {
    const parsedParts: Record<string, unknown> = {}
    const issues: { part: string; path: string; message: string }[] = []
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part]
      if (!schema) continue
      const result = schema.safeParse(req[part])
      if (result.success) {
        parsedParts[part] = result.data
      } else {
        for (const issue of result.error.issues) {
          issues.push({ part, path: issue.path.join('.'), message: issue.message })
        }
      }
    }
    if (issues.length > 0) throw new AppError(400, 'invalid_request', 'The request is not valid.', issues)
    res.locals.input = parsedParts
    next()
  }
}

export function inputOf<T>(res: Response): T {
  return res.locals.input as T
}
```

`apps/core/src/health.ts`:

```ts
import { Router } from 'express'
import type { Logger } from 'pino'

interface HealthDeps {
  logger: Logger
  ready: () => Promise<void>
  now: () => Date
}

export function healthRouter(deps: HealthDeps): Router {
  const router = Router()
  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' })
  })
  router.get('/ready', async (_req, res) => {
    try {
      await deps.ready()
      res.json({ status: 'ok' })
    } catch (err) {
      deps.logger.warn({ err }, 'readiness check failed')
      res.status(503).json({ status: 'unavailable' })
    }
  })
  router.get('/heartbeat', (_req, res) => {
    res.json({ status: 'ok', at: deps.now().toISOString() })
  })
  return router
}
```

`apps/core/src/app.ts`:

```ts
import express, { type Express, type RequestHandler, type Router } from 'express'
import helmet from 'helmet'
import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import { pinoHttp } from 'pino-http'
import { errorHandler, notFoundHandler } from './errors.ts'
import { healthRouter } from './health.ts'

export interface AppDeps {
  logger: Logger
  ready: () => Promise<void>
  now?: () => Date
  // Number of proxies in front of the service. Set to 1 behind the server's proxy at deployment.
  trustProxy?: number
  guard?: RequestHandler
  authHandler?: RequestHandler
  api?: Router
}

// The query string and any reset token in the path never reach the log.
export function redactUrl(url: string | undefined): string {
  const path = (url ?? '').split('?')[0] ?? ''
  return path.replace(/\/reset-password\/[^/]+/, '/reset-password/[token]')
}

export function createApp(deps: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', deps.trustProxy ?? 0)
  app.use(helmet())
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (_req, res) => {
        const id = randomUUID()
        res.setHeader('x-request-id', id)
        return id
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: redactUrl(req.url) }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  )
  app.use('/health', healthRouter({ logger: deps.logger, ready: deps.ready, now: deps.now ?? (() => new Date()) }))
  if (deps.guard) app.use('/api', deps.guard)
  // The auth library reads the raw request body, so it is mounted before the JSON parser.
  if (deps.authHandler) app.all('/api/auth/*splat', deps.authHandler)
  app.use(express.json({ limit: '100kb', strict: true }))
  if (deps.api) app.use('/api/v1', deps.api)
  app.use(notFoundHandler)
  app.use(errorHandler(deps.logger))
  return app
}
```

If `pinoHttp` is not a named export of pinned pino-http 11.0.0, use its default export and record a ruling.

- [ ] **Step 4: Run to verify they pass**

Run (server): `npx vitest run apps/core`
Expected: PASS for all files in `apps/core`.

- [ ] **Step 5: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps
git commit -m "feat(core): service shell with strict validation, error envelope, security headers and health endpoints"
```

---

### Task 3: Cross-site request guard (acceptance test 12, first part)

**Files:**

- Create: `apps/core/src/guard.ts`
- Test: `apps/core/test/guard.test.ts`

**Interfaces:**

- Consumes: `AppError`, `createApp` (Task 2)
- Produces:
  - `csrfTokenFor(secret: string, sessionId: string): string` (HMAC-SHA256, hex)
  - `requestGuard(options: { allowedOrigins: string[]; secret: string; sessionIdFor: (req: Request) => Promise<string | null> }): RequestHandler`. For GET, HEAD and OPTIONS it does nothing. For every other method it refuses (403) with: `cross_site_request` when `Sec-Fetch-Site` is `cross-site`; `bad_origin` when `Origin` is missing or not in the list; `bad_csrf_token` when a session exists and `X-CSRF-Token` is missing or is not the token for that session.

- [ ] **Step 1: Write the failing test**

`apps/core/test/guard.test.ts`:

```ts
import { Router } from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { csrfTokenFor, requestGuard } from '../src/guard.ts'
import { createLogger } from '../src/logger.ts'
import { startTestServer, type TestServer } from './support.ts'

const ORIGIN = 'https://app.example.test'
const SECRET = 's'.repeat(40)
let server: TestServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

async function start(sessionId: string | null) {
  const api = Router()
  api.get('/read', (_req, res) => {
    res.json({ ok: true })
  })
  api.post('/write', (_req, res) => {
    res.json({ ok: true })
  })
  server = await startTestServer(
    createApp({
      logger: createLogger('silent'),
      ready: async () => undefined,
      guard: requestGuard({ allowedOrigins: [ORIGIN], secret: SECRET, sessionIdFor: async () => sessionId }),
      api,
    }),
  )
  return server.url
}

const write = (url: string, headers: Record<string, string>) =>
  fetch(`${url}/api/v1/write`, { method: 'POST', headers, body: '{}' })

describe('request guard', () => {
  it('lets a read through with no origin and no token', async () => {
    const url = await start('session-1')
    expect((await fetch(`${url}/api/v1/read`)).status).toBe(200)
  })

  it('refuses a write that carries no Origin header', async () => {
    const url = await start(null)
    const res = await write(url, { 'content-type': 'application/json' })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('bad_origin')
  })

  it('refuses a write from another origin, and one the browser marks cross-site', async () => {
    const url = await start(null)
    const other = await write(url, { 'content-type': 'application/json', origin: 'https://evil.example.test' })
    expect(other.status).toBe(403)
    expect((await other.json()).error.code).toBe('bad_origin')
    const cross = await write(url, {
      'content-type': 'application/json',
      origin: ORIGIN,
      'sec-fetch-site': 'cross-site',
    })
    expect(cross.status).toBe(403)
    expect((await cross.json()).error.code).toBe('cross_site_request')
  })

  it('lets a write from the right origin through when there is no session', async () => {
    const url = await start(null)
    expect((await write(url, { 'content-type': 'application/json', origin: ORIGIN })).status).toBe(200)
  })

  it('needs the per-session token once there is a session', async () => {
    const url = await start('session-1')
    const base = { 'content-type': 'application/json', origin: ORIGIN }
    const none = await write(url, base)
    expect(none.status).toBe(403)
    expect((await none.json()).error.code).toBe('bad_csrf_token')
    expect((await write(url, { ...base, 'x-csrf-token': 'wrong' })).status).toBe(403)
    expect((await write(url, { ...base, 'x-csrf-token': csrfTokenFor(SECRET, 'session-2') })).status).toBe(403)
    expect((await write(url, { ...base, 'x-csrf-token': csrfTokenFor(SECRET, 'session-1') })).status).toBe(200)
  })

  it('derives a different token for each session and each secret', () => {
    expect(csrfTokenFor(SECRET, 'a')).toBe(csrfTokenFor(SECRET, 'a'))
    expect(csrfTokenFor(SECRET, 'a')).not.toBe(csrfTokenFor(SECRET, 'b'))
    expect(csrfTokenFor(SECRET, 'a')).not.toBe(csrfTokenFor('t'.repeat(40), 'a'))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run (server): `npx vitest run apps/core/test/guard.test.ts`
Expected: FAIL, `../src/guard.ts` does not exist.

- [ ] **Step 3: Write the guard**

`apps/core/src/guard.ts`:

```ts
import type { Request, RequestHandler } from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from './errors.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// The token is derived from the session, so it needs no storage and changes with every session.
export function csrfTokenFor(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('hex')
}

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export interface GuardOptions {
  allowedOrigins: string[]
  secret: string
  sessionIdFor: (req: Request) => Promise<string | null>
}

export function requestGuard(options: GuardOptions): RequestHandler {
  const allowed = new Set(options.allowedOrigins)
  return async (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next()
      return
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new AppError(403, 'cross_site_request', 'This request was sent from another site.')
    }
    const origin = req.headers.origin
    if (typeof origin !== 'string' || !allowed.has(origin)) {
      throw new AppError(403, 'bad_origin', 'This request did not come from this application.')
    }
    const sessionId = await options.sessionIdFor(req)
    if (sessionId) {
      const sent = req.headers['x-csrf-token']
      if (typeof sent !== 'string' || !sameValue(sent, csrfTokenFor(options.secret, sessionId))) {
        throw new AppError(403, 'bad_csrf_token', 'The request token is missing or wrong.')
      }
    }
    next()
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run (server): `npx vitest run apps/core`
Expected: PASS.

- [ ] **Step 5: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps
git commit -m "feat(core): origin check and per-session token on every state-changing request"
```

---

### Task 4: Ports, the auth options and the `auth` schema migration

**Files:**

- Create: `apps/core/src/ports.ts`, `apps/core/src/testing.ts`, `apps/core/src/auth/policy.ts`, `apps/core/src/auth/options.ts`, `apps/core/src/auth/print-schema.ts`
- Create: `packages/db/migrations/0006_auth_schema.sql`
- Modify: `packages/db/src/testing.ts` (`seedBrand`), `apps/core/package.json` (script)
- Test: `packages/db/test/auth-schema.test.ts`, `apps/core/test/auth-schema-drift.test.ts`

**Interfaces:**

- Consumes: `createPool`, `Pool` (Task 1); `createTestDatabase`, `seedBrand` from `@mkt/db/testing`
- Produces:
  - `Mailer = { send(message: { to: string; subject: string; text: string }): Promise<void> }`; `AuditSink = { record(entry: AuditEntry): Promise<void> }` where `AuditEntry = { action: string; actor: string | null; subject?: string | null; brandId?: string | null; outcome: 'success' | 'failure'; detail?: Record<string, unknown> }`
  - `MemoryMailer` (`.sent: MailMessage[]`) and `MemoryAudit` (`.entries: AuditEntry[]`) from `apps/core/src/testing.ts`
  - Constants from `policy.ts`: `PASSWORD_MIN = 12`, `PASSWORD_MAX = 128`, `SESSION_IDLE_SECONDS = 1800`, `SESSION_REFRESH_SECONDS = 300`, `RESET_LINK_SECONDS = 1800`, `INVITE_HOURS = 72`, `LOCK_MAX_FAILURES = 5`, `LOCK_WINDOW_MS = 900000`, `LOCK_DURATION_MS = 900000`, `BACKUP_CODE_COUNT = 10`, `BACKUP_CODE_LENGTH = 10`
  - `authOptions(deps: AuthDeps): BetterAuthOptions` and `createAuth(deps: AuthDeps)`, with `type Auth = ReturnType<typeof createAuth>`, where `AuthDeps = { pool: Pool; secret: string; baseURL: string; mailer: Mailer; audit: AuditSink }`
  - The `auth` schema with tables `user`, `session`, `account`, `verification`, `twoFactor`; `mkt_app` may read and write them; no other run-time role may touch them; eight foreign keys from `app` tables to `auth."user"` (decision 3)
  - `seedBrand` now creates a real `auth."user"` row and uses its ID

- [ ] **Step 1: Write the failing tests**

`packages/db/test/auth-schema.test.ts`:

```ts
import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, seedBrand, type TestDatabase } from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const TABLES = ['account', 'session', 'twoFactor', 'user', 'verification']

describe('the auth schema', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    await seedBrand(db, A, 'brand-a')
  })
  afterAll(async () => db.drop())

  it('has exactly the sign-in library tables, so a library upgrade that adds one is a deliberate change', async () => {
    const result = await db.admin.query(
      "select table_name from information_schema.tables where table_schema = 'auth' and table_type = 'BASE TABLE'",
    )
    expect(result.rows.map((r) => r.table_name).sort()).toEqual([...TABLES].sort())
  })

  it('uses uuid for the user ID, so our tables can reference it', async () => {
    const result = await db.admin.query(
      "select data_type from information_schema.columns where table_schema = 'auth' and table_name = 'user' and column_name = 'id'",
    )
    expect(result.rows[0].data_type).toBe('uuid')
  })

  it('lets the application role read and write every table', async () => {
    for (const table of TABLES) {
      for (const privilege of ['select', 'insert', 'update', 'delete']) {
        const result = await db.admin.query('select has_table_privilege($1, $2, $3) as ok', [
          'mkt_app',
          `auth."${table}"`,
          privilege,
        ])
        expect(result.rows[0].ok, `${table} ${privilege}`).toBe(true)
      }
    }
  })

  it('gives no other run-time role any right, so password hashes are not readable by them', async () => {
    for (const role of ['mkt_readonly', 'mkt_queue', 'mkt_audit_writer', 'mkt_owner_view']) {
      for (const table of TABLES) {
        const result = await db.admin.query('select has_table_privilege($1, $2, $3) as ok', [
          role,
          `auth."${table}"`,
          'select',
        ])
        expect(result.rows[0].ok, `${role} ${table}`).toBe(false)
      }
    }
  })

  it('refuses the application role creating or altering anything in the schema', async () => {
    const client = new pg.Client({ connectionString: db.urlFor('app') })
    await client.connect()
    try {
      await expect(client.query('create table auth.nope (id int)')).rejects.toMatchObject({ code: '42501' })
      await expect(client.query('alter table auth."user" add column nope int')).rejects.toMatchObject({
        code: '42501',
      })
    } finally {
      await client.end()
    }
  })

  it('references auth.user from the eight columns the schema document names, and enforces it', async () => {
    const result = await db.admin.query(
      `select count(*)::int as n from pg_constraint
        where contype = 'f' and confrelid = 'auth."user"'::regclass and conrelid::regclass::text like 'app.%'`,
    )
    expect(result.rows[0].n).toBe(8)
    await expect(
      db.admin.query("insert into app.membership (brand_id, user_id, role) values ($1, gen_random_uuid(), 'viewer')", [A]),
    ).rejects.toMatchObject({ code: '23503' })
  })
})
```

`apps/core/test/auth-schema-drift.test.ts`:

```ts
import { createPool, type Pool } from '@mkt/db'
import { createTestDatabase, type TestDatabase } from '@mkt/db/testing'
import { requireDatabase } from '@mkt/test-support'
import { getMigrations } from 'better-auth/db/migration'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authOptions } from '../src/auth/options.ts'
import { MemoryAudit, MemoryMailer } from '../src/testing.ts'

describe('the committed auth migration matches what the pinned library expects', () => {
  let db: TestDatabase
  let pool: Pool
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    pool = createPool(db.urlFor('app'), { searchPath: 'auth' })
  })
  afterAll(async () => {
    await pool.end()
    await db.drop()
  })

  it('has nothing left to create or add, so a library upgrade that needs a change is noticed', async () => {
    const plan = await getMigrations(
      authOptions({
        pool,
        secret: 's'.repeat(40),
        baseURL: 'https://app.example.test',
        mailer: new MemoryMailer(),
        audit: new MemoryAudit(),
      }),
    )
    expect(plan.toBeCreated).toEqual([])
    expect(plan.toBeAdded).toEqual([])
    expect(plan.toBeAddedIndexes).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run (server): `npx vitest run packages/db/test/auth-schema.test.ts apps/core/test/auth-schema-drift.test.ts`
Expected: FAIL, the `auth` schema does not exist; `../src/auth/options.ts` does not exist.

- [ ] **Step 3: Write the ports, the test doubles and the policy**

`apps/core/src/ports.ts`:

```ts
export interface MailMessage {
  to: string
  subject: string
  text: string
}

// Email delivery. The real implementation (Nodemailer) arrives with notification delivery, package 11.
export interface Mailer {
  send(message: MailMessage): Promise<void>
}

export interface AuditEntry {
  action: string
  actor: string | null
  subject?: string | null
  brandId?: string | null
  outcome: 'success' | 'failure'
  detail?: Record<string, unknown>
}

// The audit log. The real implementation (hash chain) arrives with package 6.
export interface AuditSink {
  record(entry: AuditEntry): Promise<void>
}
```

`apps/core/src/testing.ts`:

```ts
import type { AuditEntry, AuditSink, MailMessage, Mailer } from './ports.ts'

export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = []
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message)
  }
}

export class MemoryAudit implements AuditSink {
  readonly entries: AuditEntry[] = []
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry)
  }
}
```

`apps/core/src/auth/policy.ts`:

```ts
// Proposed values. The spec fixes the rules; these figures are confirmed by the owner (plan 2b).
export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 128
export const SESSION_IDLE_SECONDS = 30 * 60
export const SESSION_REFRESH_SECONDS = 5 * 60
export const RESET_LINK_SECONDS = 30 * 60
export const INVITE_HOURS = 72
export const LOCK_MAX_FAILURES = 5
export const LOCK_WINDOW_MS = 15 * 60 * 1000
export const LOCK_DURATION_MS = 15 * 60 * 1000
export const BACKUP_CODE_COUNT = 10
export const BACKUP_CODE_LENGTH = 10
```

- [ ] **Step 4: Write the auth options and the schema printer**

`apps/core/src/auth/options.ts`:

```ts
import type { Pool } from '@mkt/db'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { twoFactor } from 'better-auth/plugins'
import type { AuditSink, Mailer } from '../ports.ts'
import {
  BACKUP_CODE_COUNT,
  BACKUP_CODE_LENGTH,
  PASSWORD_MAX,
  PASSWORD_MIN,
  SESSION_IDLE_SECONDS,
  SESSION_REFRESH_SECONDS,
} from './policy.ts'

export interface AuthDeps {
  pool: Pool
  secret: string
  baseURL: string
  mailer: Mailer
  audit: AuditSink
}

export function authOptions(deps: AuthDeps): BetterAuthOptions {
  return {
    appName: 'Marketing platform',
    baseURL: deps.baseURL,
    basePath: '/api/auth',
    secret: deps.secret,
    trustedOrigins: [deps.baseURL],
    database: deps.pool,
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: deps.baseURL.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
    },
    session: { expiresIn: SESSION_IDLE_SECONDS, updateAge: SESSION_REFRESH_SECONDS },
    plugins: [
      twoFactor({
        issuer: 'Marketing platform',
        skipVerificationOnEnable: false,
        backupCodeOptions: { amount: BACKUP_CODE_COUNT, length: BACKUP_CODE_LENGTH },
      }),
    ],
  }
}

export function createAuth(deps: AuthDeps) {
  return betterAuth(authOptions(deps))
}

export type Auth = ReturnType<typeof createAuth>
```

`apps/core/src/auth/print-schema.ts`:

```ts
import { createPool } from '@mkt/db'
import { createTestDatabase } from '@mkt/db/testing'
import { getMigrations } from 'better-auth/db/migration'
import { MemoryAudit, MemoryMailer } from '../testing.ts'
import { authOptions } from './options.ts'

// Prints the SQL the pinned sign-in library needs, as its `generate` command would, against an empty
// `auth` schema in a throw-away database. The output is reviewed and committed as a migration.
const db = await createTestDatabase()
try {
  await db.admin.query('create schema auth')
  await db.admin.query('grant usage, create on schema auth to mkt_migration')
  const pool = createPool(db.urlFor('migration'), { searchPath: 'auth' })
  try {
    const { compileMigrations } = await getMigrations(
      authOptions({
        pool,
        secret: 's'.repeat(40),
        baseURL: 'https://app.example.test',
        mailer: new MemoryMailer(),
        audit: new MemoryAudit(),
      }),
    )
    process.stdout.write(`${await compileMigrations()}\n`)
  } finally {
    await pool.end()
  }
} finally {
  await db.drop()
}
```

In `apps/core/package.json` add `"scripts": { "auth:schema": "node src/auth/print-schema.ts" }`.

- [ ] **Step 5: Generate the SQL and review it**

Run (server): `npm run -s auth:schema --workspace @mkt/core > /work/.auth-schema.sql`, then copy it back: `scp root@<dev-server>:/opt/mkt-dev/marketing/.auth-schema.sql ./.auth-schema.sql`.

Expected: the file holds `create table` statements for `user`, `session`, `account`, `verification` and `twoFactor` (and indexes). Review it before use:

- `user.id` and every `userId` column are `uuid`.
- `user` has `email` (unique), `emailVerified`, `twoFactorEnabled`, `createdAt`, `updatedAt`.
- `twoFactor` has `secret`, `backupCodes` and `userId`.
- There is no `drop` statement and nothing outside the five tables.

If the pinned library names things differently, keep what it printed and adjust the tests in Step 1 to match, recording a ruling in `docs/progress.md`.

- [ ] **Step 6: Write the migration around the generated SQL**

Write `.auth-header.sql`:

```sql
-- Up Migration
-- The sign-in library's tables, in their own schema. The SQL between the markers was produced by
-- `npm run auth:schema` (better-auth 1.7.2), reviewed and committed. The library's own migrate command
-- is never run, and the application role cannot create or alter tables.
create schema auth;
grant usage on schema auth to mkt_app;
set local search_path to auth;

-- BEGIN generated
```

Write `.auth-footer.sql`:

```sql
-- END generated

grant select, insert, update, delete on all tables in schema auth to mkt_app;

-- Our tables refer to a user by the library's user ID (database schema, section 4).
alter table app.platform_owner add constraint platform_owner_user_fk foreign key (user_id) references auth."user" (id);
alter table app.platform_owner add constraint platform_owner_granted_by_fk foreign key (granted_by) references auth."user" (id);
alter table app.membership add constraint membership_user_fk foreign key (user_id) references auth."user" (id);
alter table app.membership add constraint membership_created_by_fk foreign key (created_by) references auth."user" (id);
alter table app.invite add constraint invite_invited_by_fk foreign key (invited_by) references auth."user" (id);
alter table app.approval_setting add constraint approval_setting_updated_by_fk foreign key (updated_by) references auth."user" (id);
alter table app.approval add constraint approval_decided_by_fk foreign key (decided_by) references auth."user" (id);
alter table app.approval_request add constraint approval_request_escalated_to_fk foreign key (escalated_to) references auth."user" (id);

-- Down Migration
alter table app.approval_request drop constraint approval_request_escalated_to_fk;
alter table app.approval drop constraint approval_decided_by_fk;
alter table app.approval_setting drop constraint approval_setting_updated_by_fk;
alter table app.invite drop constraint invite_invited_by_fk;
alter table app.membership drop constraint membership_created_by_fk;
alter table app.membership drop constraint membership_user_fk;
alter table app.platform_owner drop constraint platform_owner_granted_by_fk;
alter table app.platform_owner drop constraint platform_owner_user_fk;
drop schema auth cascade;
```

Then: `cat .auth-header.sql .auth-schema.sql .auth-footer.sql > packages/db/migrations/0006_auth_schema.sql && rm .auth-header.sql .auth-schema.sql .auth-footer.sql`.

- [ ] **Step 7: Make the seed create a real user**

In `packages/db/src/testing.ts`, in `seedBrand`, after the `app.brand` insert and before the membership insert, add:

```ts
    const user = await client.query(
      `insert into auth."user" (name, email, "emailVerified") values ($1, $2, true) returning id`,
      [slug, `${slug}@example.test`],
    )
    const userId = user.rows[0].id as string
```

Change the membership insert to use it:

```ts
    await client.query("insert into app.membership (brand_id, user_id, role) values ($1, $2, 'approver')", [id, userId])
```

and the invite insert to pass `userId` for `invited_by` instead of `gen_random_uuid()` (add it as the third parameter, `$3`).

- [ ] **Step 8: Run the database suite and fix the fallout**

Run (server): `npx vitest run packages/db`
Expected: PASS. Any older test that inserts a random UUID into one of the eight columns now fails with `23503`; change it to use a real user (for example from `seedBrand`) and name it in the commit message. If `seedBrand`'s insert fails for a missing default, add the column the error names.

- [ ] **Step 9: Run the new tests, then every check, and commit**

Run (server): `npx vitest run apps/core packages/db`
Expected: PASS, including the drift test.

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps packages
git commit -m "feat(auth): auth schema from the pinned library, grants, foreign keys to auth.user, ports and auth options"
```

---

### Task 5: Sessions, the enrolment gate and the wired service (acceptance test 8)

**Files:**

- Create: `apps/core/src/auth/users.ts`, `apps/core/src/auth/session.ts`, `apps/core/src/api.ts`, `apps/core/src/core.ts`
- Modify: `apps/core/test/support.ts` (stack, client, helpers)
- Test: `apps/core/test/enrolment-gate.test.ts`

**Interfaces:**

- Consumes: `createAuth`, `Auth`, `AuthDeps` (Task 4); `requestGuard`, `csrfTokenFor` (Task 3); `createApp` (Task 2); `createPool` (Task 1)
- Produces:
  - `createUserWithPassword(auth: Auth, input: { email: string; name: string; password: string }): Promise<{ id: string }>`; it throws `AppError(409, 'account_exists', …)` when the email is taken. It creates the user through the library's internal adapter, because the sign-up route is disabled for everyone.
  - `type Role = 'brand_admin' | 'approver' | 'sales_contact' | 'viewer'`; `type Principal = { userId: string; sessionId: string; email: string; name: string; twoFactorEnabled: boolean; isPlatformOwner: boolean; memberships: { brandId: string; role: Role }[]; needsSecondFactor: boolean }`
  - `needsSecondFactor(isPlatformOwner: boolean, memberships: { role: Role }[]): boolean`
  - `loadPrincipal(auth: Auth, pool: Pool): RequestHandler` (401 `not_signed_in` when there is no session; sets `res.locals.principal`), `principalOf(res): Principal`, `enrolmentGate: RequestHandler` (403 `enrolment_required`)
  - `createApiRouter(deps: { auth: Auth; pool: Pool; secret: string }): Router`: `GET /session` first, then a marked place for public routes, then `loadPrincipal` and `enrolmentGate` for everything after it. `GET /api/v1/session` returns `{ user: { id, email, name }, twoFactorEnabled, needsSecondFactor, enrolmentRequired, platformOwner, memberships, csrfToken }`.
  - `buildCore(deps: CoreDeps): { app: Express; auth: Auth; api: Router }` where `CoreDeps = { config: Config; logger: Logger; appPool: Pool; authPool: Pool; mailer: Mailer; audit: AuditSink }`
  - From `support.ts`: `createStack(): Promise<Stack>` (database, pools, in-memory mailer and audit, the running app), `Stack.close()`, `Stack.newClient(): TestClient`, `addBrand(stack, slug): Promise<string>`, `addUser(stack, { email, password, role?, brandId?, platformOwner? }): Promise<string>`, and `TestClient` with `request(method, path, { body?, origin?, csrf?, headers? })` returning `{ status, json, text, headers, setCookies }`, a cookie jar, `csrf: string | null`, `signIn(email, password)` and `refreshCsrf()`

- [ ] **Step 1: Write the test support**

Append to `apps/core/test/support.ts` (keep the imports at the top of the file in one block):

```ts
import { createPool, type Pool } from '@mkt/db'
import { createTestDatabase, type TestDatabase } from '@mkt/db/testing'
import { requireDatabase } from '@mkt/test-support'
import type { Config } from '../src/config.ts'
import { buildCore } from '../src/core.ts'
import { createLogger } from '../src/logger.ts'
import { createUserWithPassword } from '../src/auth/users.ts'
import type { Role } from '../src/auth/session.ts'
import { MemoryAudit, MemoryMailer } from '../src/testing.ts'

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
  json: any
  text: string
  headers: Headers
  setCookies: string[]
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
    options: { body?: unknown; origin?: string | null; csrf?: boolean; headers?: Record<string, string> } = {},
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
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, json, text, headers: res.headers, setCookies }
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
```

- [ ] **Step 2: Write the failing test**

`apps/core/test/enrolment-gate.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { needsSecondFactor } from '../src/auth/session.ts'
import { addBrand, addUser, createStack, type Stack } from './support.ts'

describe('who needs a second factor', () => {
  it('exempts only a user whose every membership is Viewer', () => {
    expect(needsSecondFactor(false, [{ role: 'viewer' }])).toBe(false)
    expect(needsSecondFactor(false, [{ role: 'viewer' }, { role: 'viewer' }])).toBe(false)
  })

  it('requires one for every other role, for a viewer who is also an approver elsewhere, and for no memberships', () => {
    for (const role of ['brand_admin', 'approver', 'sales_contact'] as const) {
      expect(needsSecondFactor(false, [{ role }])).toBe(true)
    }
    expect(needsSecondFactor(false, [{ role: 'viewer' }, { role: 'approver' }])).toBe(true)
    expect(needsSecondFactor(false, [])).toBe(true)
    expect(needsSecondFactor(true, [])).toBe(true)
    expect(needsSecondFactor(true, [{ role: 'viewer' }])).toBe(true)
  })
})

describe('sign-in and the enrolment gate (acceptance test 8)', () => {
  let stack: Stack
  let brand: string
  const PASSWORD = 'correct horse battery'

  beforeAll(async () => {
    stack = await createStack()
    // A route behind the gate, standing in for every real one.
    stack.core.api.get('/test-protected', (_req, res) => {
      res.json({ ok: true })
    })
    brand = await addBrand(stack, 'brand-a')
    await addUser(stack, { email: 'approver@example.test', password: PASSWORD, role: 'approver', brandId: brand })
    await addUser(stack, { email: 'viewer@example.test', password: PASSWORD, role: 'viewer', brandId: brand })
    await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
  })
  afterAll(async () => stack.close())

  it('answers 401 to a protected route with no session', async () => {
    const res = await stack.newClient().request('GET', '/api/v1/test-protected')
    expect(res.status).toBe(401)
    expect(res.json.error.code).toBe('not_signed_in')
  })

  it('lets an approver sign in but reach nothing except enrolment until a second factor is set', async () => {
    const client = stack.newClient()
    const signIn = await client.signIn('approver@example.test', PASSWORD)
    expect(signIn.status).toBe(200)
    const session = await client.request('GET', '/api/v1/session')
    expect(session.status).toBe(200)
    expect(session.json).toMatchObject({
      user: { email: 'approver@example.test' },
      twoFactorEnabled: false,
      needsSecondFactor: true,
      enrolmentRequired: true,
      platformOwner: false,
      memberships: [{ brandId: brand, role: 'approver' }],
    })
    const blocked = await client.request('GET', '/api/v1/test-protected')
    expect(blocked.status).toBe(403)
    expect(blocked.json.error.code).toBe('enrolment_required')
  })

  it('treats a platform owner with no brand as needing a second factor', async () => {
    const client = stack.newClient()
    await client.signIn('owner@example.test', PASSWORD)
    const blocked = await client.request('GET', '/api/v1/test-protected')
    expect(blocked.status).toBe(403)
    expect(blocked.json.error.code).toBe('enrolment_required')
    expect((await client.request('GET', '/api/v1/session')).json.platformOwner).toBe(true)
  })

  it('lets a Viewer in with email and password only', async () => {
    const client = stack.newClient()
    expect((await client.signIn('viewer@example.test', PASSWORD)).status).toBe(200)
    const session = await client.request('GET', '/api/v1/session')
    expect(session.json).toMatchObject({ needsSecondFactor: false, enrolmentRequired: false })
    expect((await client.request('GET', '/api/v1/test-protected')).status).toBe(200)
  })

  it('gives the same error for a wrong password and an unknown email', async () => {
    const wrong = await stack.newClient().signIn('viewer@example.test', 'not the password!')
    const unknown = await stack.newClient().signIn('nobody@example.test', 'not the password!')
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(wrong.status)
    expect(unknown.json).toEqual(wrong.json)
  })

  it('has no self-registration', async () => {
    const client = stack.newClient()
    const res = await client.request('POST', '/api/auth/sign-up/email', {
      body: { email: 'new@example.test', name: 'New', password: PASSWORD },
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    const count = await stack.db.admin.query("select count(*)::int as n from auth.\"user\" where email = 'new@example.test'")
    expect(count.rows[0].n).toBe(0)
  })

  it('sets a secure, http-only, same-site session cookie', async () => {
    const client = stack.newClient()
    const res = await client.request('POST', '/api/auth/sign-in/email', {
      body: { email: 'viewer@example.test', password: PASSWORD },
    })
    const cookie = res.setCookies.find((line) => /session_token/.test(line)) ?? ''
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).toMatch(/Secure/i)
  })

  it('refuses a sign-in from another origin, and a write with no session token (acceptance test 12)', async () => {
    const other = await stack.newClient().request('POST', '/api/auth/sign-in/email', {
      body: { email: 'viewer@example.test', password: PASSWORD },
      origin: 'https://evil.example.test',
    })
    expect(other.status).toBe(403)
    const client = stack.newClient()
    await client.signIn('viewer@example.test', PASSWORD)
    const noToken = await client.request('POST', '/api/auth/sign-out', { csrf: false })
    expect(noToken.status).toBe(403)
    expect(noToken.json.error.code).toBe('bad_csrf_token')
    expect((await client.request('POST', '/api/auth/sign-out')).status).toBe(200)
    expect((await client.request('GET', '/api/v1/session')).status).toBe(401)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run (server): `npx vitest run apps/core/test/enrolment-gate.test.ts`
Expected: FAIL, `../src/auth/session.ts` and `../src/core.ts` do not exist.

- [ ] **Step 4: Write the user helper, the session module, the router and the composition**

`apps/core/src/auth/users.ts`:

```ts
import { AppError } from '../errors.ts'
import type { Auth } from './options.ts'

// Sign-up is switched off for everyone, so a user is made through the library's internal adapter.
// The caller checks the password against the policy before calling this.
export async function createUserWithPassword(
  auth: Auth,
  input: { email: string; name: string; password: string },
): Promise<{ id: string }> {
  const context = await auth.$context
  const email = input.email.trim().toLowerCase()
  if (await context.internalAdapter.findUserByEmail(email)) {
    throw new AppError(409, 'account_exists', 'An account already exists for this email address.')
  }
  const hash = await context.password.hash(input.password)
  let user: { id: string }
  try {
    user = await context.internalAdapter.createUser({ email, name: input.name, emailVerified: true })
  } catch (error) {
    // Two requests can pass the check above together; the database's unique email key stops the second.
    if (await context.internalAdapter.findUserByEmail(email)) {
      throw new AppError(409, 'account_exists', 'An account already exists for this email address.')
    }
    throw error
  }
  await context.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: hash,
  })
  return { id: user.id }
}

export async function deleteUser(auth: Auth, userId: string): Promise<void> {
  const context = await auth.$context
  await context.internalAdapter.deleteUser(userId)
}
```

`apps/core/src/auth/session.ts`:

```ts
import type { Pool } from '@mkt/db'
import { fromNodeHeaders } from 'better-auth/node'
import type { RequestHandler, Response } from 'express'
import { AppError } from '../errors.ts'
import type { Auth } from './options.ts'

export type Role = 'brand_admin' | 'approver' | 'sales_contact' | 'viewer'

export interface Principal {
  userId: string
  sessionId: string
  email: string
  name: string
  twoFactorEnabled: boolean
  isPlatformOwner: boolean
  memberships: { brandId: string; role: Role }[]
  needsSecondFactor: boolean
}

// SEC-1. Only a user whose every membership is Viewer is exempt. No memberships, or any other role,
// or being a platform owner, means a second factor is required.
export function needsSecondFactor(isPlatformOwner: boolean, memberships: { role: Role }[]): boolean {
  if (isPlatformOwner) return true
  if (memberships.length === 0) return true
  return memberships.some((membership) => membership.role !== 'viewer')
}

export function loadPrincipal(auth: Auth, pool: Pool): RequestHandler {
  return async (req, res, next) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) throw new AppError(401, 'not_signed_in', 'Sign in to continue.')
    const userId = session.user.id
    // No brand is set yet, so these two named functions read across brands for this one user.
    const owner = await pool.query('select app.is_platform_owner($1) as owner', [userId])
    const rows = await pool.query('select brand_id, role from app.memberships_for_user($1)', [userId])
    const memberships = rows.rows.map((row) => ({ brandId: row.brand_id as string, role: row.role as Role }))
    const isPlatformOwner = Boolean(owner.rows[0]?.owner)
    const principal: Principal = {
      userId,
      sessionId: session.session.id,
      email: session.user.email,
      name: session.user.name,
      twoFactorEnabled: Boolean((session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled),
      isPlatformOwner,
      memberships,
      needsSecondFactor: needsSecondFactor(isPlatformOwner, memberships),
    }
    res.locals.principal = principal
    next()
  }
}

export function principalOf(res: Response): Principal {
  return res.locals.principal as Principal
}

// Until a second factor is set, only the enrolment routes (the library's, under /api/auth) work.
export const enrolmentGate: RequestHandler = (_req, res, next) => {
  const principal = principalOf(res)
  if (principal.needsSecondFactor && !principal.twoFactorEnabled) {
    throw new AppError(403, 'enrolment_required', 'Set up a second factor first.')
  }
  next()
}
```

`apps/core/src/api.ts`:

```ts
import type { Pool } from '@mkt/db'
import { Router } from 'express'
import { enrolmentGate, loadPrincipal, principalOf } from './auth/session.ts'
import type { Auth } from './auth/options.ts'
import { csrfTokenFor } from './guard.ts'

export interface ApiDeps {
  auth: Auth
  pool: Pool
  secret: string
}

export function createApiRouter(deps: ApiDeps): Router {
  const api = Router()

  api.get('/session', loadPrincipal(deps.auth, deps.pool), (_req, res) => {
    const principal = principalOf(res)
    res.json({
      user: { id: principal.userId, email: principal.email, name: principal.name },
      twoFactorEnabled: principal.twoFactorEnabled,
      needsSecondFactor: principal.needsSecondFactor,
      enrolmentRequired: principal.needsSecondFactor && !principal.twoFactorEnabled,
      platformOwner: principal.isPlatformOwner,
      memberships: principal.memberships,
      csrfToken: csrfTokenFor(deps.secret, principal.sessionId),
    })
  })

  // PUBLIC ROUTES (no session) are added above this line.

  // Everything below needs a session, and for most roles a completed enrolment.
  api.use(loadPrincipal(deps.auth, deps.pool), enrolmentGate)
  return api
}
```

`apps/core/src/core.ts`:

```ts
import type { Pool } from '@mkt/db'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import type { Express, Router } from 'express'
import type { Logger } from 'pino'
import { createApiRouter } from './api.ts'
import { createApp } from './app.ts'
import { createAuth, type Auth } from './auth/options.ts'
import type { Config } from './config.ts'
import { requestGuard } from './guard.ts'
import type { AuditSink, Mailer } from './ports.ts'

export interface CoreDeps {
  config: Config
  logger: Logger
  appPool: Pool
  authPool: Pool
  mailer: Mailer
  audit: AuditSink
}

export function buildCore(deps: CoreDeps): { app: Express; auth: Auth; api: Router } {
  const { config } = deps
  const auth = createAuth({
    pool: deps.authPool,
    secret: config.authSecret,
    baseURL: config.publicOrigin,
    mailer: deps.mailer,
    audit: deps.audit,
  })
  const guard = requestGuard({
    allowedOrigins: [config.publicOrigin],
    secret: config.authSecret,
    sessionIdFor: async (req) => {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
      return session?.session.id ?? null
    },
  })
  const api = createApiRouter({ auth, pool: deps.appPool, secret: config.authSecret })
  const app = createApp({
    logger: deps.logger,
    ready: async () => {
      await deps.appPool.query('select 1')
    },
    guard,
    authHandler: toNodeHandler(auth),
    api,
  })
  return { app, auth, api }
}
```

- [ ] **Step 5: Run to verify it passes**

Run (server): `npx vitest run apps/core`
Expected: PASS. If `auth.$context`, `internalAdapter.createUser` or `linkAccount` differ in the pinned 1.7.2, use what its types show and record a ruling; the behaviour (a credential account with a hashed password) must not change. If sign-up for a disabled route answers 200, stop: that is a SEC-1 failure, not a test problem.

- [ ] **Step 6: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps
git commit -m "feat(auth): sessions, the second-factor enrolment gate, current-session route and the wired service"
```

---

### Task 6: Invites (acceptance test 11)

**Files:**

- Create: `packages/db/migrations/0007_invite_functions.sql`, `apps/core/src/auth/invites.ts`, `apps/core/src/routes/invites.ts`
- Modify: `apps/core/src/api.ts` (mount the public routes), `apps/core/test/support.ts` (a helper)
- Test: `packages/db/test/invite-functions.test.ts`, `apps/core/test/invites.test.ts`

**Interfaces:**

- Consumes: `createUserWithPassword`, `deleteUser` (Task 5); `withBrand`, `Pool` (`@mkt/db`); `Mailer`; `validate`, `inputOf`; `PASSWORD_MIN`, `PASSWORD_MAX`, `INVITE_HOURS`
- Produces:
  - Database functions (security definer, owned by `mkt_definer`, executable by `mkt_app` only): `app.peek_invite(p_token_hash bytea) returns table (email text, role app.membership_role, brand_name text)`, which returns a row only for an invite that is unused and unexpired; `app.redeem_invite(p_token_hash bytea, p_user uuid) returns table (brand_id uuid, role app.membership_role)`, which atomically marks it used and inserts the membership, and raises SQLSTATE `MKT01` when the invite is not valid.
  - `hashInviteToken(token: string): Buffer`
  - `createInvite(pool: Pool, mailer: Mailer, input: { brandId: string; email: string; role: Role; invitedBy: string; origin: string }): Promise<{ id: string; expiresAt: Date }>`. It stores only the hash, and emails the link `<origin>/accept-invite?token=<token>`.
  - `acceptInvite(auth: Auth, pool: Pool, input: { token: string; name: string; password: string }): Promise<{ userId: string; brandId: string }>`. Unknown, used and expired invites all give `AppError(410, 'invite_invalid', …)` with the same message.
  - Routes (public, no session): `POST /api/v1/invites/lookup` body `{ token }` returns `{ email, role, brandName }`; `POST /api/v1/invites/accept` body `{ token, name, password }` returns 201 `{ userId }`.
  - `tokenFromMail(message: MailMessage): string` in `support.ts`

- [ ] **Step 1: Write the failing database test**

`packages/db/test/invite-functions.test.ts`:

```ts
import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, seedBrand, type RoleName, type TestDatabase } from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const HASH = '\\x' + 'ab'.repeat(32)

async function query(db: TestDatabase, role: RoleName, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: db.urlFor(role) })
  await client.connect()
  try {
    return await client.query(sql, params)
  } finally {
    await client.end()
  }
}

describe('invite functions', () => {
  let db: TestDatabase
  let inviter: string
  let invitee: string

  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    await seedBrand(db, A, 'brand-a')
    inviter = (await db.admin.query("select user_id from app.membership where brand_id = $1", [A])).rows[0].user_id
    invitee = (await db.admin.query(`insert into auth."user" (name, email, "emailVerified") values ('i','i@example.test',true) returning id`)).rows[0].id
    await db.admin.query(
      `insert into app.invite (brand_id, email, role, token_hash, expires_at, invited_by)
       values ($1, 'i@example.test', 'approver', $2::bytea, now() + interval '72 hours', $3)`,
      [A, HASH, inviter],
    )
  })
  afterAll(async () => db.drop())

  it('shows an unused, unexpired invite and nothing else', async () => {
    const found = await query(db, 'app', 'select * from app.peek_invite($1::bytea)', [HASH])
    expect(found.rows).toEqual([{ email: 'i@example.test', role: 'approver', brand_name: 'brand-a' }])
    const none = await query(db, 'app', 'select * from app.peek_invite($1::bytea)', ['\\x' + 'cd'.repeat(32)])
    expect(none.rows).toEqual([])
  })

  it('redeems once: marks it used, adds the membership, and refuses a second time', async () => {
    const first = await query(db, 'app', 'select * from app.redeem_invite($1::bytea, $2)', [HASH, invitee])
    expect(first.rows).toEqual([{ brand_id: A, role: 'approver' }])
    const member = await db.admin.query('select role from app.membership where brand_id = $1 and user_id = $2', [A, invitee])
    expect(member.rows).toEqual([{ role: 'approver' }])
    await expect(query(db, 'app', 'select * from app.redeem_invite($1::bytea, $2)', [HASH, invitee])).rejects.toMatchObject({
      code: 'MKT01',
    })
    const peek = await query(db, 'app', 'select * from app.peek_invite($1::bytea)', [HASH])
    expect(peek.rows).toEqual([])
  })

  it('refuses an expired invite', async () => {
    const hash = '\\x' + 'ef'.repeat(32)
    await db.admin.query(
      `insert into app.invite (brand_id, email, role, token_hash, expires_at, invited_by)
       values ($1, 'late@example.test', 'viewer', $2::bytea, now() - interval '1 second', $3)`,
      [A, hash, inviter],
    )
    expect((await query(db, 'app', 'select * from app.peek_invite($1::bytea)', [hash])).rows).toEqual([])
    await expect(query(db, 'app', 'select * from app.redeem_invite($1::bytea, $2)', [hash, invitee])).rejects.toMatchObject({
      code: 'MKT01',
    })
  })

  it('lets only the application role call them', async () => {
    for (const role of ['readonly', 'queue', 'audit_writer', 'owner_view'] as const) {
      await expect(query(db, role, 'select * from app.peek_invite($1::bytea)', [HASH]), role).rejects.toMatchObject({
        code: '42501',
      })
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run (server): `npx vitest run packages/db/test/invite-functions.test.ts`
Expected: FAIL, `function app.peek_invite(bytea) does not exist`.

- [ ] **Step 3: Write the migration**

`packages/db/migrations/0007_invite_functions.sql`:

```sql
-- Up Migration
-- An invited person is not yet a member of any brand, so redeeming an invite is done by named functions
-- owned by the definer role, as in 0005. The definer holds CREATE on schema app only while it takes ownership.
grant create on schema app to mkt_definer;

create policy definer_read_invite on app.invite for select to mkt_definer using (true);
create policy definer_update_invite on app.invite for update to mkt_definer using (true) with check (true);
create policy definer_insert_membership on app.membership for insert to mkt_definer with check (true);
grant select, update on app.invite to mkt_definer;
grant insert on app.membership to mkt_definer;

create function app.peek_invite(p_token_hash bytea)
returns table (email text, role app.membership_role, brand_name text)
language sql security definer set search_path = pg_catalog, app
as $$
  select i.email::text, i.role, b.name
    from app.invite i join app.brand b on b.id = i.brand_id
   where i.token_hash = p_token_hash and i.used_at is null and i.expires_at > now()
$$;
alter function app.peek_invite(bytea) owner to mkt_definer;
revoke all on function app.peek_invite(bytea) from public;
grant execute on function app.peek_invite(bytea) to mkt_app;

create function app.redeem_invite(p_token_hash bytea, p_user uuid)
returns table (brand_id uuid, role app.membership_role)
language plpgsql security definer set search_path = pg_catalog, app
as $$
declare inv app.invite%rowtype;
begin
  select * into inv from app.invite i
   where i.token_hash = p_token_hash and i.used_at is null and i.expires_at > now()
   for update;
  if not found then
    raise exception 'invite is not valid' using errcode = 'MKT01';
  end if;
  update app.invite set used_at = now() where id = inv.id;
  insert into app.membership (brand_id, user_id, role, created_by)
    values (inv.brand_id, p_user, inv.role, inv.invited_by);
  return query select inv.brand_id, inv.role;
end $$;
alter function app.redeem_invite(bytea, uuid) owner to mkt_definer;
revoke all on function app.redeem_invite(bytea, uuid) from public;
grant execute on function app.redeem_invite(bytea, uuid) to mkt_app;

revoke create on schema app from mkt_definer;

-- Down Migration
drop function app.redeem_invite(bytea, uuid);
drop function app.peek_invite(bytea);
drop policy definer_insert_membership on app.membership;
drop policy definer_update_invite on app.invite;
drop policy definer_read_invite on app.invite;
```

Run (server): `npx vitest run packages/db`
Expected: PASS, including the new file. If the `for update` row lock is refused, check that the update policy is present, and do not widen any policy to the run-time roles.

- [ ] **Step 4: Write the failing service test**

Add to `apps/core/test/support.ts`:

```ts
import type { MailMessage } from '../src/ports.ts'

export function tokenFromMail(message: MailMessage): string {
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(message.text)
  if (!match) throw new Error('no token in the message')
  return match[1] as string
}
```

`apps/core/test/invites.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createInvite } from '../src/auth/invites.ts'
import { ORIGIN, addBrand, addUser, createStack, tokenFromMail, type Stack } from './support.ts'

const PASSWORD = 'a long enough password'

describe('invites (acceptance test 11)', () => {
  let stack: Stack
  let brand: string
  let admin: string

  beforeAll(async () => {
    stack = await createStack()
    brand = await addBrand(stack, 'brand-a')
    admin = await addUser(stack, { email: 'admin@example.test', password: PASSWORD, role: 'brand_admin', brandId: brand })
  })
  afterAll(async () => stack.close())

  async function invite(email: string, role: 'approver' | 'viewer' = 'approver') {
    const before = stack.mailer.sent.length
    const created = await createInvite(stack.appPool, stack.mailer, { brandId: brand, email, role, invitedBy: admin, origin: ORIGIN })
    expect(stack.mailer.sent.length).toBe(before + 1)
    const message = stack.mailer.sent[before]!
    return { created, message, token: tokenFromMail(message) }
  }

  const accept = (client = stack.newClient(), body: Record<string, unknown>) =>
    client.request('POST', '/api/v1/invites/accept', { body })

  it('emails the link to the invitee and stores only a hash of the token', async () => {
    const { created, message, token } = await invite('one@example.test')
    expect(message.to).toBe('one@example.test')
    expect(message.text).toContain(`${ORIGIN}/accept-invite?token=`)
    const row = await stack.db.admin.query('select * from app.invite where id = $1', [created.id])
    expect(JSON.stringify(row.rows[0])).not.toContain(token)
    expect(row.rows[0].token_hash).toBeInstanceOf(Buffer)
    expect(row.rows[0].token_hash.length).toBe(32)
  })

  it('expires 72 hours after it was made', async () => {
    const { created } = await invite('two@example.test')
    const row = await stack.db.admin.query(
      "select extract(epoch from (expires_at - created_at)) as seconds from app.invite where id = $1",
      [created.id],
    )
    expect(Number(row.rows[0].seconds)).toBe(72 * 3600)
  })

  it('shows the invitee their email, role and brand without a session', async () => {
    const { token } = await invite('look@example.test', 'viewer')
    const res = await stack.newClient().request('POST', '/api/v1/invites/lookup', { body: { token } })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ email: 'look@example.test', role: 'viewer', brandName: 'brand-a' })
  })

  it('creates the account and membership on acceptance, and the person can then sign in', async () => {
    const { token } = await invite('accepted@example.test')
    const res = await accept(undefined, { token, name: 'Ada', password: PASSWORD })
    expect(res.status).toBe(201)
    const member = await stack.db.admin.query(
      'select m.role, m.created_by from app.membership m where m.user_id = $1 and m.brand_id = $2',
      [res.json.userId, brand],
    )
    expect(member.rows).toEqual([{ role: 'approver', created_by: admin }])
    expect((await stack.newClient().signIn('accepted@example.test', PASSWORD)).status).toBe(200)
  })

  it('refuses a second use of the same invite', async () => {
    const { token } = await invite('once@example.test')
    expect((await accept(undefined, { token, name: 'A', password: PASSWORD })).status).toBe(201)
    const again = await accept(undefined, { token, name: 'A', password: 'another long password' })
    expect(again.status).toBe(410)
    expect(again.json.error.code).toBe('invite_invalid')
  })

  it('refuses an expired invite, leaves no account behind, and gives the same answer as an unknown token', async () => {
    const { created, token } = await invite('late@example.test')
    await stack.db.admin.query("update app.invite set expires_at = now() - interval '1 second' where id = $1", [created.id])
    const late = await accept(undefined, { token, name: 'L', password: PASSWORD })
    expect(late.status).toBe(410)
    const unknown = await accept(undefined, { token: 'x'.repeat(43), name: 'L', password: PASSWORD })
    expect(unknown.status).toBe(410)
    expect(unknown.json).toEqual(late.json)
    const users = await stack.db.admin.query("select count(*)::int as n from auth.\"user\" where email = 'late@example.test'")
    expect(users.rows[0].n).toBe(0)
  })

  it('produces exactly one account and one membership when the invite is accepted twice at once', async () => {
    const { token } = await invite('race@example.test')
    const replies = await Promise.all([
      accept(stack.newClient(), { token, name: 'R', password: PASSWORD }),
      accept(stack.newClient(), { token, name: 'R', password: PASSWORD }),
    ])
    expect(replies.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1)
    expect(replies.filter((r) => r.status !== 201)[0]!.status).toBeGreaterThanOrEqual(400)
    const users = await stack.db.admin.query("select id from auth.\"user\" where email = 'race@example.test'")
    expect(users.rows).toHaveLength(1)
    const members = await stack.db.admin.query('select count(*)::int as n from app.membership where user_id = $1', [users.rows[0].id])
    expect(members.rows[0].n).toBe(1)
  })

  it('refuses an invite for an email that already has an account, and does not use the invite up', async () => {
    await addUser(stack, { email: 'existing@example.test', password: PASSWORD })
    const { token } = await invite('existing@example.test')
    const res = await accept(undefined, { token, name: 'E', password: PASSWORD })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('account_exists')
    const peek = await stack.newClient().request('POST', '/api/v1/invites/lookup', { body: { token } })
    expect(peek.status).toBe(200)
  })

  it('refuses a short password and an unknown field before touching the invite', async () => {
    const { token } = await invite('short@example.test')
    expect((await accept(undefined, { token, name: 'S', password: 'short' })).status).toBe(400)
    expect((await accept(undefined, { token, name: 'S', password: PASSWORD, role: 'brand_admin' })).status).toBe(400)
    expect((await stack.newClient().request('POST', '/api/v1/invites/lookup', { body: { token } })).status).toBe(200)
  })

  it('refuses an accept from another origin', async () => {
    const { token } = await invite('origin@example.test')
    const res = await stack.newClient().request('POST', '/api/v1/invites/accept', {
      body: { token, name: 'O', password: PASSWORD },
      origin: 'https://evil.example.test',
    })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 5: Run to verify it fails**

Run (server): `npx vitest run apps/core/test/invites.test.ts`
Expected: FAIL, `../src/auth/invites.ts` does not exist.

- [ ] **Step 6: Write the service and the routes**

`apps/core/src/auth/invites.ts`:

```ts
import { withBrand, type Pool } from '@mkt/db'
import { createHash, randomBytes } from 'node:crypto'
import { AppError } from '../errors.ts'
import type { Mailer } from '../ports.ts'
import { INVITE_HOURS } from './policy.ts'
import type { Auth } from './options.ts'
import type { Role } from './session.ts'
import { createUserWithPassword, deleteUser } from './users.ts'

export function hashInviteToken(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

export async function createInvite(
  pool: Pool,
  mailer: Mailer,
  input: { brandId: string; email: string; role: Role; invitedBy: string; origin: string },
): Promise<{ id: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const email = input.email.trim().toLowerCase()
  const row = await withBrand(pool, input.brandId, async (client) => {
    const result = await client.query(
      `insert into app.invite (brand_id, email, role, token_hash, expires_at, invited_by)
       values ($1, $2, $3, $4, now() + make_interval(hours => $5), $6)
       returning id, expires_at`,
      [input.brandId, email, input.role, hashInviteToken(token), INVITE_HOURS, input.invitedBy],
    )
    return result.rows[0] as { id: string; expires_at: Date }
  })
  await mailer.send({
    to: email,
    subject: 'You have been invited',
    text: `You have been invited. Open this link to set a password:\n${input.origin}/accept-invite?token=${token}\nThe link works once and expires in ${INVITE_HOURS} hours.`,
  })
  return { id: row.id, expiresAt: row.expires_at }
}

const INVALID = () => new AppError(410, 'invite_invalid', 'This invite is no longer valid. Ask for a new one.')

export async function peekInvite(
  pool: Pool,
  token: string,
): Promise<{ email: string; role: Role; brandName: string } | null> {
  const result = await pool.query('select email, role, brand_name from app.peek_invite($1)', [hashInviteToken(token)])
  const row = result.rows[0]
  return row ? { email: row.email, role: row.role, brandName: row.brand_name } : null
}

export async function lookupInvite(pool: Pool, token: string) {
  const found = await peekInvite(pool, token)
  if (!found) throw INVALID()
  return found
}

// Order: check the invite, make the account, then redeem. If redeeming loses a race, the account just
// made is removed, so a refused accept never leaves a user behind.
export async function acceptInvite(
  auth: Auth,
  pool: Pool,
  input: { token: string; name: string; password: string },
): Promise<{ userId: string; brandId: string }> {
  const invite = await peekInvite(pool, input.token)
  if (!invite) throw INVALID()
  const { id: userId } = await createUserWithPassword(auth, {
    email: invite.email,
    name: input.name,
    password: input.password,
  })
  try {
    const redeemed = await pool.query('select brand_id from app.redeem_invite($1, $2)', [
      hashInviteToken(input.token),
      userId,
    ])
    return { userId, brandId: redeemed.rows[0].brand_id as string }
  } catch (error) {
    await deleteUser(auth, userId)
    if ((error as { code?: string }).code === 'MKT01') throw INVALID()
    throw error
  }
}
```

`apps/core/src/routes/invites.ts`:

```ts
import type { Pool } from '@mkt/db'
import { Router } from 'express'
import { z } from 'zod'
import { acceptInvite, lookupInvite } from '../auth/invites.ts'
import type { Auth } from '../auth/options.ts'
import { PASSWORD_MAX, PASSWORD_MIN } from '../auth/policy.ts'
import { inputOf, validate } from '../validate.ts'

const token = z.string().min(20).max(200)
const lookupBody = z.strictObject({ token })
const acceptBody = z.strictObject({
  token,
  name: z.string().trim().min(1).max(100),
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
})

// Public: the person has no session yet. The origin check in the request guard still applies.
export function inviteRoutes(deps: { auth: Auth; pool: Pool }): Router {
  const router = Router()
  router.post('/lookup', validate({ body: lookupBody }), async (_req, res) => {
    const { body } = inputOf<{ body: z.infer<typeof lookupBody> }>(res)
    res.json(await lookupInvite(deps.pool, body.token))
  })
  router.post('/accept', validate({ body: acceptBody }), async (_req, res) => {
    const { body } = inputOf<{ body: z.infer<typeof acceptBody> }>(res)
    const accepted = await acceptInvite(deps.auth, deps.pool, body)
    res.status(201).json({ userId: accepted.userId })
  })
  return router
}
```

In `apps/core/src/api.ts` import `inviteRoutes` from `./routes/invites.ts` and replace the line `// PUBLIC ROUTES (no session) are added above this line.` with:

```ts
  api.use('/invites', inviteRoutes({ auth: deps.auth, pool: deps.pool }))
  // Public routes (no session) are added above this line.
```

- [ ] **Step 7: Run to verify it passes**

Run (server): `npx vitest run apps/core packages/db`
Expected: PASS.

- [ ] **Step 8: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps packages
git commit -m "feat(auth): single-use 72-hour invites redeemed through named database functions"
```

---

### Task 7: The second factor, backup codes and the rule that it cannot be turned off (acceptance test 9, SEC-1)

**Files:**

- Modify: `apps/core/src/auth/options.ts` (hooks), `apps/core/test/support.ts` (TOTP helper and enrolment helper)
- Test: `apps/core/test/second-factor.test.ts`

**Interfaces:**

- Consumes: Task 4 and 5 modules; `AuditSink`, `Mailer`
- Produces:
  - `totp(secretBase32: string, atMs?: number): string` and `enrol(client: TestClient, password: string): Promise<{ secret: string; backupCodes: string[] }>` in `support.ts`
  - In the library options, a `before` hook that refuses `/two-factor/disable` for everyone (403, SEC-1), and an `after` hook that, on `/two-factor/verify-backup-code`, records an audit entry `auth.backup_code_used` (success or failure) and, on success, emails the user that a backup code was used

- [ ] **Step 1: Add the test helpers**

Append to `apps/core/test/support.ts` (`createHmac` joins the existing `node:crypto` import if there is one):

```ts
import { createHmac } from 'node:crypto'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Decode(input: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(ch)
    if (index < 0) throw new Error('not base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return Buffer.from(out)
}

// RFC 6238, six digits, thirty-second steps: the code an authenticator app would show.
export function totp(secretBase32: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const hash = createHmac('sha1', base32Decode(secretBase32)).update(message).digest()
  const offset = (hash[hash.length - 1] as number) & 0x0f
  const number =
    (((hash[offset] as number) & 0x7f) << 24) |
    (((hash[offset + 1] as number) & 0xff) << 16) |
    (((hash[offset + 2] as number) & 0xff) << 8) |
    ((hash[offset + 3] as number) & 0xff)
  return String(number % 1_000_000).padStart(6, '0')
}

// Walks the first-sign-in path for a client that has signed in: set up the authenticator and confirm it.
export async function enrol(client: TestClient, password: string): Promise<{ secret: string; backupCodes: string[] }> {
  const enable = await client.request('POST', '/api/auth/two-factor/enable', { body: { password } })
  if (enable.status !== 200) throw new Error(`enable failed: ${enable.status} ${enable.text}`)
  const secret = new URL(enable.json.totpURI).searchParams.get('secret')
  if (!secret) throw new Error('no secret in the authenticator URI')
  const verify = await client.request('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp(secret) } })
  if (verify.status !== 200) throw new Error(`verify failed: ${verify.status} ${verify.text}`)
  await client.refreshCsrf()
  return { secret, backupCodes: enable.json.backupCodes as string[] }
}
```

- [ ] **Step 2: Write the failing test**

`apps/core/test/second-factor.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BACKUP_CODE_COUNT } from '../src/auth/policy.ts'
import { addBrand, addUser, createStack, enrol, totp, type Stack } from './support.ts'

const PASSWORD = 'correct horse battery'
const EMAIL = 'approver@example.test'

describe('second factor and backup codes (acceptance test 9, SEC-1)', () => {
  let stack: Stack
  let secret: string
  let codes: string[]

  beforeAll(async () => {
    stack = await createStack()
    stack.core.api.get('/test-protected', (_req, res) => {
      res.json({ ok: true })
    })
    const brand = await addBrand(stack, 'brand-a')
    await addUser(stack, { email: EMAIL, password: PASSWORD, role: 'approver', brandId: brand })
  })
  afterAll(async () => stack.close())

  it('enrols: shows backup codes once, and opens the gate only after the code is confirmed', async () => {
    const client = stack.newClient()
    await client.signIn(EMAIL, PASSWORD)
    const enable = await client.request('POST', '/api/auth/two-factor/enable', { body: { password: PASSWORD } })
    expect(enable.status).toBe(200)
    expect(enable.json.backupCodes).toHaveLength(BACKUP_CODE_COUNT)
    secret = new URL(enable.json.totpURI).searchParams.get('secret') as string
    codes = enable.json.backupCodes
    // Not confirmed yet, so the gate is still closed.
    expect((await client.request('GET', '/api/v1/test-protected')).status).toBe(403)
    const wrong = await client.request('POST', '/api/auth/two-factor/verify-totp', { body: { code: '000000' } })
    expect(wrong.status).toBeGreaterThanOrEqual(400)
    expect((await client.request('GET', '/api/v1/test-protected')).status).toBe(403)
    const right = await client.request('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp(secret) } })
    expect(right.status).toBe(200)
    await client.refreshCsrf()
    expect((await client.request('GET', '/api/v1/test-protected')).status).toBe(200)
    expect((await client.request('GET', '/api/v1/session')).json.twoFactorEnabled).toBe(true)
  })

  it('does not store backup codes in the clear', async () => {
    const stored = await stack.db.admin.query('select "backupCodes" from auth."twoFactor"')
    for (const code of codes) expect(JSON.stringify(stored.rows)).not.toContain(code)
  })

  it('asks for the code after the password, and gives no session before it', async () => {
    const client = stack.newClient()
    const signIn = await client.signIn(EMAIL, PASSWORD)
    expect(signIn.status).toBe(200)
    expect(signIn.json.twoFactorRedirect).toBe(true)
    expect((await client.request('GET', '/api/v1/session')).status).toBe(401)
    const verify = await client.request('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp(secret) } })
    expect(verify.status).toBe(200)
    await client.refreshCsrf()
    expect((await client.request('GET', '/api/v1/test-protected')).status).toBe(200)
  })

  it('accepts a backup code once, audits and notifies it, and refuses it the second time', async () => {
    const before = stack.mailer.sent.length
    const first = stack.newClient()
    expect((await first.signIn(EMAIL, PASSWORD)).json.twoFactorRedirect).toBe(true)
    const used = await first.request('POST', '/api/auth/two-factor/verify-backup-code', { body: { code: codes[0] } })
    expect(used.status).toBe(200)
    const success = stack.audit.entries.filter((e) => e.action === 'auth.backup_code_used' && e.outcome === 'success')
    expect(success).toHaveLength(1)
    expect(success[0]!.actor).toMatch(/^[0-9a-f-]{36}$/)
    const mail = stack.mailer.sent.slice(before).find((m) => /backup code/i.test(m.subject))
    expect(mail?.to).toBe(EMAIL)

    const second = stack.newClient()
    await second.signIn(EMAIL, PASSWORD)
    const again = await second.request('POST', '/api/auth/two-factor/verify-backup-code', { body: { code: codes[0] } })
    expect(again.status).toBeGreaterThanOrEqual(400)
    expect(stack.audit.entries.some((e) => e.action === 'auth.backup_code_used' && e.outcome === 'failure')).toBe(true)
    const other = await second.request('POST', '/api/auth/two-factor/verify-backup-code', { body: { code: codes[1] } })
    expect(other.status).toBe(200)
  })

  it('keeps no code, password or secret in what it audits or emails', async () => {
    const text = JSON.stringify([stack.audit.entries, stack.mailer.sent])
    for (const value of [PASSWORD, secret, ...codes]) expect(text).not.toContain(value)
  })

  it('refuses to turn the second factor off, for anyone (SEC-1)', async () => {
    const client = stack.newClient()
    await client.signIn(EMAIL, PASSWORD)
    await client.request('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp(secret, Date.now() + 30_000) } })
    await client.refreshCsrf()
    const off = await client.request('POST', '/api/auth/two-factor/disable', { body: { password: PASSWORD } })
    expect(off.status).toBe(403)
    expect((await client.request('GET', '/api/v1/session')).json.twoFactorEnabled).toBe(true)
  })

  it('can run the whole enrolment through the helper for a second person', async () => {
    const brand = await addBrand(stack, 'brand-b')
    await addUser(stack, { email: 'admin-b@example.test', password: PASSWORD, role: 'brand_admin', brandId: brand })
    const client = stack.newClient()
    await client.signIn('admin-b@example.test', PASSWORD)
    const enrolled = await enrol(client, PASSWORD)
    expect(enrolled.backupCodes).toHaveLength(BACKUP_CODE_COUNT)
    expect((await client.request('GET', '/api/v1/test-protected')).status).toBe(200)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run (server): `npx vitest run apps/core/test/second-factor.test.ts`
Expected: FAIL: the backup-code audit and mail are missing, and `two-factor/disable` is not refused. If enrolment itself fails (for example the TOTP code is rejected), check that the otpauth URI's `secret` is base32 as `totp()` assumes, and fix the helper, not the library.

- [ ] **Step 4: Add the hooks to the auth options**

In `apps/core/src/auth/options.ts` add the imports:

```ts
import { APIError, createAuthMiddleware } from 'better-auth/api'
```

and add this property to the returned options object, after `plugins`:

```ts
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // SEC-1: there is no way to turn the second factor off. A lost one is reset by the platform owner.
        if (ctx.path === '/two-factor/disable') {
          throw new APIError('FORBIDDEN', { message: 'The second factor cannot be turned off.' })
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/two-factor/verify-backup-code') return
        const returned = ctx.context.returned
        const failed = returned instanceof APIError
        const user = ctx.context.newSession?.user
        await deps.audit.record({
          action: 'auth.backup_code_used',
          actor: user?.id ?? null,
          outcome: failed ? 'failure' : 'success',
        })
        if (!failed && user) {
          await deps.mailer.send({
            to: user.email,
            subject: 'A backup code was used to sign in',
            text: 'A backup code was just used to sign in to your account. If this was not you, contact the platform owner.',
          })
        }
      }),
    },
```

If the pinned library reports a failed hook outcome some other way (for example `isAPIError(returned)` from `better-auth/api`, or a `ctx.context.returned` of `{ error }`), use that and record a ruling; the behaviour must stay: one audit entry per attempt, a mail only on success.

- [ ] **Step 5: Run to verify it passes**

Run (server): `npx vitest run apps/core`
Expected: PASS. If a backup code or a TOTP code is refused as a replay inside the same 30-second step, move the second use to the next step (`totp(secret, Date.now() + 30_000)`) as the disable test does, and record that as a finding.

- [ ] **Step 6: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps
git commit -m "feat(auth): second-factor enrolment, single-use audited backup codes, and no way to turn it off"
```

---

### Task 8: Password recovery (acceptance test 10)

**Files:**

- Modify: `apps/core/src/auth/options.ts`
- Test: `apps/core/test/recovery.test.ts`

**Interfaces:**

- Consumes: `Mailer`, `RESET_LINK_SECONDS`, `PASSWORD_MIN`, helpers from Task 5 and 7
- Produces: in the library options, `emailAndPassword.sendResetPassword`, `resetPasswordTokenExpiresIn: RESET_LINK_SECONDS` and `revokeSessionsOnPasswordReset: true`. The emailed link is `<baseURL>/reset-password?token=<token>`. The dashboard posts the token and the new password to `POST /api/auth/reset-password`.

- [ ] **Step 1: Write the failing test**

`apps/core/test/recovery.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBrand, addUser, createStack, enrol, tokenFromMail, type Stack } from './support.ts'

const OLD = 'the old password!!'
const NEW = 'a brand new password'

describe('password recovery (acceptance test 10)', () => {
  let stack: Stack
  let brand: string

  beforeAll(async () => {
    stack = await createStack()
    brand = await addBrand(stack, 'brand-a')
  })
  afterAll(async () => stack.close())

  async function request(email: string) {
    const before = stack.mailer.sent.length
    const res = await stack.newClient().request('POST', '/api/auth/request-password-reset', { body: { email } })
    return { res, mails: stack.mailer.sent.slice(before) }
  }

  it('answers the same for an address with no account, and sends nothing', async () => {
    await addUser(stack, { email: 'known@example.test', password: OLD, role: 'viewer', brandId: brand })
    const known = await request('known@example.test')
    const unknown = await request('nobody@example.test')
    expect(known.res.status).toBe(200)
    expect(unknown.res.status).toBe(known.res.status)
    expect(unknown.res.json).toEqual(known.res.json)
    expect(known.mails).toHaveLength(1)
    expect(known.mails[0]!.to).toBe('known@example.test')
    expect(unknown.mails).toHaveLength(0)
  })

  it('lasts 30 minutes', async () => {
    await addUser(stack, { email: 'time@example.test', password: OLD, role: 'viewer', brandId: brand })
    await request('time@example.test')
    const row = await stack.db.admin.query(
      `select extract(epoch from ("expiresAt" - "createdAt")) as seconds from auth.verification order by "createdAt" desc limit 1`,
    )
    expect(Number(row.rows[0].seconds)).toBeGreaterThanOrEqual(30 * 60 - 2)
    expect(Number(row.rows[0].seconds)).toBeLessThanOrEqual(30 * 60 + 2)
  })

  it('works once: the new password signs in, the old one does not, the same link is then refused', async () => {
    await addUser(stack, { email: 'once@example.test', password: OLD, role: 'viewer', brandId: brand })
    const { mails } = await request('once@example.test')
    const token = tokenFromMail(mails[0]!)
    const client = stack.newClient()
    const reset = await client.request('POST', '/api/auth/reset-password', { body: { newPassword: NEW, token } })
    expect(reset.status).toBe(200)
    expect(reset.setCookies.some((c) => /session_token/.test(c))).toBe(false)
    expect((await stack.newClient().signIn('once@example.test', OLD)).status).toBe(401)
    expect((await stack.newClient().signIn('once@example.test', NEW)).status).toBe(200)
    const again = await client.request('POST', '/api/auth/reset-password', { body: { newPassword: 'yet another one!!', token } })
    expect(again.status).toBeGreaterThanOrEqual(400)
  })

  it('is refused after it expires', async () => {
    await addUser(stack, { email: 'late@example.test', password: OLD, role: 'viewer', brandId: brand })
    const { mails } = await request('late@example.test')
    await stack.db.admin.query(`update auth.verification set "expiresAt" = now() - interval '1 second'`)
    const res = await stack
      .newClient()
      .request('POST', '/api/auth/reset-password', { body: { newPassword: NEW, token: tokenFromMail(mails[0]!) } })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await stack.newClient().signIn('late@example.test', OLD)).status).toBe(200)
  })

  it('ends every existing session', async () => {
    await addUser(stack, { email: 'sessions@example.test', password: OLD, role: 'viewer', brandId: brand })
    const open = stack.newClient()
    await open.signIn('sessions@example.test', OLD)
    expect((await open.request('GET', '/api/v1/session')).status).toBe(200)
    const { mails } = await request('sessions@example.test')
    await stack
      .newClient()
      .request('POST', '/api/auth/reset-password', { body: { newPassword: NEW, token: tokenFromMail(mails[0]!) } })
    expect((await open.request('GET', '/api/v1/session')).status).toBe(401)
  })

  it('still asks for the second factor after a reset', async () => {
    await addUser(stack, { email: 'second@example.test', password: OLD, role: 'approver', brandId: brand })
    const first = stack.newClient()
    await first.signIn('second@example.test', OLD)
    await enrol(first, OLD)
    const { mails } = await request('second@example.test')
    await stack
      .newClient()
      .request('POST', '/api/auth/reset-password', { body: { newPassword: NEW, token: tokenFromMail(mails[0]!) } })
    const next = stack.newClient()
    const signIn = await next.signIn('second@example.test', NEW)
    expect(signIn.json.twoFactorRedirect).toBe(true)
    expect((await next.request('GET', '/api/v1/session')).status).toBe(401)
  })

  it('refuses a new password that is too short', async () => {
    await addUser(stack, { email: 'weak@example.test', password: OLD, role: 'viewer', brandId: brand })
    const { mails } = await request('weak@example.test')
    const res = await stack
      .newClient()
      .request('POST', '/api/auth/reset-password', { body: { newPassword: 'short', token: tokenFromMail(mails[0]!) } })
    expect(res.status).toBe(400)
  })

  it('puts no reset token in anything it audits', async () => {
    const text = JSON.stringify(stack.audit.entries)
    expect(text).not.toMatch(/token/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run (server): `npx vitest run apps/core/test/recovery.test.ts`
Expected: FAIL, no mail is sent for a known address.

- [ ] **Step 3: Configure recovery**

In `apps/core/src/auth/options.ts` import `RESET_LINK_SECONDS` from `./policy.ts` and replace the `emailAndPassword` block with:

```ts
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      resetPasswordTokenExpiresIn: RESET_LINK_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        await deps.mailer.send({
          to: user.email,
          subject: 'Reset your password',
          text: `Open this link to choose a new password:\n${deps.baseURL}/reset-password?token=${token}\nThe link works once and expires in 30 minutes. You will still be asked for your second factor when you sign in.`,
        })
      },
    },
```

- [ ] **Step 4: Run to verify it passes**

Run (server): `npx vitest run apps/core`
Expected: PASS. If the library sends the reset mail without awaiting it (so the response time differs between a known and an unknown address), note that as a finding; the status and body must still match.

- [ ] **Step 5: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps
git commit -m "feat(auth): password recovery by a single-use 30-minute link that ends all sessions"
```

---

### Task 9: Rate limits, lockout and the audit of every attempt

**Files:**

- Create: `apps/core/src/auth/limiter.ts`
- Modify: `apps/core/src/auth/options.ts` (hooks, `AuthDeps.limiter`), `apps/core/src/api.ts`, `apps/core/src/routes/invites.ts`, `apps/core/src/core.ts`, `apps/core/test/support.ts`
- Test: `apps/core/test/limiter.test.ts`, `apps/core/test/lockout.test.ts`

**Interfaces:**

- Consumes: `AuditSink`, `LOCK_*` constants, the hooks from Task 7
- Produces:
  - `class AttemptLimiter` with `constructor(options: { maxFailures: number; windowMs: number; lockMs: number; now?: () => number })`, `check(key: string): number` (milliseconds still locked, `0` when free), `fail(key: string): void`, `succeed(key: string): void`
  - `attemptKey(path: string, identifier: string): string` (lower-cases and trims the identifier)
  - `AuthDeps` gains `limiter: AttemptLimiter`; `CoreDeps` gains an optional `limiter?: AttemptLimiter` (default: one built from the `LOCK_*` constants); `createApiRouter` gains `limiter`
  - Audited actions: `auth.sign_in`, `auth.second_factor`, `auth.backup_code_used`, `auth.password_reset_requested`, `auth.password_reset`, `auth.invite_accepted`, `auth.locked_out`, each with `outcome` and an `emailHash` where an address is involved, never the address

- [ ] **Step 1: Write the failing unit test**

`apps/core/test/limiter.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AttemptLimiter, attemptKey } from '../src/auth/limiter.ts'

function make() {
  let now = 1_000_000
  const limiter = new AttemptLimiter({ maxFailures: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000, now: () => now })
  return { limiter, advance: (ms: number) => void (now += ms) }
}

describe('AttemptLimiter', () => {
  it('allows four failures and locks on the fifth', () => {
    const { limiter } = make()
    for (let i = 0; i < 4; i++) {
      limiter.fail('k')
      expect(limiter.check('k')).toBe(0)
    }
    limiter.fail('k')
    expect(limiter.check('k')).toBe(15 * 60_000)
  })

  it('counts down and frees the key when the lock ends', () => {
    const { limiter, advance } = make()
    for (let i = 0; i < 5; i++) limiter.fail('k')
    advance(10 * 60_000)
    expect(limiter.check('k')).toBe(5 * 60_000)
    advance(5 * 60_000)
    expect(limiter.check('k')).toBe(0)
    limiter.fail('k')
    expect(limiter.check('k')).toBe(0)
  })

  it('forgets failures older than the window', () => {
    const { limiter, advance } = make()
    for (let i = 0; i < 4; i++) limiter.fail('k')
    advance(16 * 60_000)
    limiter.fail('k')
    expect(limiter.check('k')).toBe(0)
  })

  it('clears a key on success and keeps keys apart', () => {
    const { limiter } = make()
    for (let i = 0; i < 4; i++) limiter.fail('a')
    limiter.succeed('a')
    limiter.fail('a')
    expect(limiter.check('a')).toBe(0)
    for (let i = 0; i < 5; i++) limiter.fail('b')
    expect(limiter.check('b')).toBeGreaterThan(0)
    expect(limiter.check('a')).toBe(0)
  })

  it('treats capitals and spaces in an email as the same key', () => {
    expect(attemptKey('/sign-in/email', '  Admin@Example.TEST ')).toBe(attemptKey('/sign-in/email', 'admin@example.test'))
    expect(attemptKey('/sign-in/email', 'a@x')).not.toBe(attemptKey('/request-password-reset', 'a@x'))
  })
})
```

- [ ] **Step 2: Write the failing flow test**

Add to `apps/core/test/support.ts` an optional parameter so a test can control the clock: change the signature to `createStack(options: { now?: () => number } = {})`, build `const limiter = new AttemptLimiter({ maxFailures: LOCK_MAX_FAILURES, windowMs: LOCK_WINDOW_MS, lockMs: LOCK_DURATION_MS, now: options.now })` (imports from `../src/auth/limiter.ts` and `../src/auth/policy.ts`), pass `limiter` into `buildCore`, and return it on the `Stack` as `limiter`.

`apps/core/test/lockout.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createInvite } from '../src/auth/invites.ts'
import { ORIGIN, addBrand, addUser, createStack, type Stack } from './support.ts'

const PASSWORD = 'correct horse battery'
let clock = 5_000_000
const advance = (ms: number) => void (clock += ms)

describe('rate limits, lockout and the audit of every attempt', () => {
  let stack: Stack
  let brand: string

  beforeAll(async () => {
    stack = await createStack({ now: () => clock })
    brand = await addBrand(stack, 'brand-a')
    await addUser(stack, { email: 'victim@example.test', password: PASSWORD, role: 'viewer', brandId: brand })
    await addUser(stack, { email: 'bystander@example.test', password: PASSWORD, role: 'viewer', brandId: brand })
  })
  afterAll(async () => stack.close())

  const wrong = (email: string) => stack.newClient().signIn(email, 'not the password!')

  it('locks an address after five wrong passwords, even for the right one, and frees it after 15 minutes', async () => {
    for (let i = 0; i < 5; i++) expect((await wrong('victim@example.test')).status).toBe(401)
    const locked = await stack.newClient().signIn('victim@example.test', PASSWORD)
    expect(locked.status).toBe(429)
    advance(14 * 60_000)
    expect((await stack.newClient().signIn('victim@example.test', PASSWORD)).status).toBe(429)
    advance(61_000)
    expect((await stack.newClient().signIn('victim@example.test', PASSWORD)).status).toBe(200)
  })

  it('does not lock anyone else', async () => {
    expect((await stack.newClient().signIn('bystander@example.test', PASSWORD)).status).toBe(200)
  })

  it('shares one lock between capital and lower-case spellings', async () => {
    for (let i = 0; i < 5; i++) await wrong(i % 2 ? 'BYSTANDER@example.test' : 'bystander@example.test')
    expect((await stack.newClient().signIn('Bystander@Example.test', PASSWORD)).status).toBe(429)
    advance(16 * 60_000)
  })

  it('locks an address that has no account in the same way, so lockout reveals nothing', async () => {
    const first = await wrong('ghost@example.test')
    for (let i = 0; i < 4; i++) await wrong('ghost@example.test')
    const locked = await wrong('ghost@example.test')
    expect(first.status).toBe(401)
    expect(locked.status).toBe(429)
    const real = await (async () => {
      for (let i = 0; i < 5; i++) await wrong('victim@example.test')
      return wrong('victim@example.test')
    })()
    expect(real.status).toBe(429)
    expect(real.json).toEqual(locked.json)
    advance(16 * 60_000)
  })

  it('audits every attempt, with a hash of the address and never the address or the password', async () => {
    const entries = stack.audit.entries
    expect(entries.some((e) => e.action === 'auth.sign_in' && e.outcome === 'failure')).toBe(true)
    expect(entries.some((e) => e.action === 'auth.sign_in' && e.outcome === 'success')).toBe(true)
    expect(entries.some((e) => e.action === 'auth.locked_out')).toBe(true)
    const text = JSON.stringify(entries)
    expect(text).not.toContain('example.test')
    expect(text).not.toContain(PASSWORD)
    expect(text).not.toContain('not the password')
    expect(entries.find((e) => e.action === 'auth.sign_in')!.detail).toMatchObject({ emailHash: expect.any(String) })
  })

  it('limits invite acceptance by address of the caller, and audits it', async () => {
    const admin = await addUser(stack, { email: 'admin@example.test', password: PASSWORD, role: 'brand_admin', brandId: brand })
    await createInvite(stack.appPool, stack.mailer, { brandId: brand, email: 'new@example.test', role: 'viewer', invitedBy: admin, origin: ORIGIN })
    const guess = () =>
      stack.newClient().request('POST', '/api/v1/invites/accept', {
        body: { token: 'x'.repeat(43), name: 'G', password: PASSWORD },
      })
    for (let i = 0; i < 5; i++) expect((await guess()).status).toBe(410)
    expect((await guess()).status).toBe(429)
    expect(stack.audit.entries.some((e) => e.action === 'auth.invite_accepted' && e.outcome === 'failure')).toBe(true)
  })
})
```

- [ ] **Step 3: Run to verify they fail**

Run (server): `npx vitest run apps/core/test/limiter.test.ts apps/core/test/lockout.test.ts`
Expected: FAIL, `../src/auth/limiter.ts` does not exist.

- [ ] **Step 4: Write the limiter**

`apps/core/src/auth/limiter.ts`:

```ts
export interface LimiterOptions {
  maxFailures: number
  windowMs: number
  lockMs: number
  now?: () => number
}

interface Entry {
  failures: number[]
  lockedUntil: number
}

const MAX_ENTRIES = 10_000

// Held in memory: it resets when the service restarts (plan 2b, decision 1).
export class AttemptLimiter {
  private readonly entries = new Map<string, Entry>()
  private readonly options: LimiterOptions
  private readonly now: () => number

  constructor(options: LimiterOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  // Milliseconds the key is still locked for; 0 when it is free.
  check(key: string): number {
    const entry = this.entries.get(key)
    if (!entry) return 0
    return Math.max(0, entry.lockedUntil - this.now())
  }

  fail(key: string): void {
    const now = this.now()
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 }
    entry.failures = entry.failures.filter((at) => now - at < this.options.windowMs)
    entry.failures.push(now)
    if (entry.failures.length >= this.options.maxFailures) {
      entry.lockedUntil = now + this.options.lockMs
      entry.failures = []
    }
    this.entries.set(key, entry)
    if (this.entries.size > MAX_ENTRIES) this.sweep(now)
  }

  succeed(key: string): void {
    this.entries.delete(key)
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      const idle = entry.failures.every((at) => now - at >= this.options.windowMs)
      if (idle && entry.lockedUntil <= now) this.entries.delete(key)
    }
  }
}

export function attemptKey(path: string, identifier: string): string {
  return `${path}:${identifier.trim().toLowerCase()}`
}
```

- [ ] **Step 5: Use it in the library hooks, the invite route and the composition**

In `apps/core/src/auth/options.ts`: add `limiter: AttemptLimiter` to `AuthDeps` (import the type from `./limiter.ts` along with `attemptKey`, and `createHash` from `node:crypto`). Replace the whole `hooks` property with:

```ts
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // SEC-1: there is no way to turn the second factor off. A lost one is reset by the platform owner.
        if (ctx.path === '/two-factor/disable') {
          throw new APIError('FORBIDDEN', { message: 'The second factor cannot be turned off.' })
        }
        const key = limitedKey(ctx.path, ctx.body, ctx.headers)
        if (key && deps.limiter.check(key) > 0) {
          await deps.audit.record({ action: 'auth.locked_out', actor: null, outcome: 'failure', detail: { path: ctx.path } })
          throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many attempts. Try again later.' })
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const action = AUDITED[ctx.path]
        if (!action) return
        const returned = ctx.context.returned
        const failed = returned instanceof APIError
        const user = ctx.context.newSession?.user ?? ctx.context.session?.user
        const key = limitedKey(ctx.path, ctx.body, ctx.headers)
        if (key) {
          if (failed) deps.limiter.fail(key)
          else deps.limiter.succeed(key)
        }
        const email = typeof (ctx.body as { email?: unknown } | undefined)?.email === 'string' ? (ctx.body as { email: string }).email : null
        await deps.audit.record({
          action,
          actor: user?.id ?? null,
          outcome: failed ? 'failure' : 'success',
          ...(email ? { detail: { emailHash: emailHash(email) } } : {}),
        })
        if (ctx.path === '/two-factor/verify-backup-code' && !failed && user) {
          await deps.mailer.send({
            to: user.email,
            subject: 'A backup code was used to sign in',
            text: 'A backup code was just used to sign in to your account. If this was not you, contact the platform owner.',
          })
        }
      }),
    },
```

and add these module-level helpers above `authOptions`:

```ts
const AUDITED: Record<string, string> = {
  '/sign-in/email': 'auth.sign_in',
  '/two-factor/verify-totp': 'auth.second_factor',
  '/two-factor/verify-backup-code': 'auth.backup_code_used',
  '/request-password-reset': 'auth.password_reset_requested',
  '/reset-password': 'auth.password_reset',
}

export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16)
}

// What a lockout is counted against. Sign-in and recovery: the address. A second-factor guess: the
// pending sign-in it belongs to, which is named by the cookie the library set after the password step.
function limitedKey(path: string, body: unknown, headers: Headers | undefined): string | null {
  const email = (body as { email?: unknown } | undefined)?.email
  if ((path === '/sign-in/email' || path === '/request-password-reset') && typeof email === 'string') {
    return attemptKey(path, email)
  }
  if (path === '/two-factor/verify-totp' || path === '/two-factor/verify-backup-code') {
    const cookie = headers?.get('cookie')
    return cookie ? attemptKey(path, createHash('sha256').update(cookie).digest('hex')) : null
  }
  return null
}
```

In `apps/core/src/routes/invites.ts`, change `inviteRoutes` to take `{ auth, pool, limiter, audit }` (types `AttemptLimiter` and `AuditSink`), and wrap the accept handler so each call is limited by the caller's address and audited:

```ts
  router.post('/accept', validate({ body: acceptBody }), async (req, res) => {
    const { body } = inputOf<{ body: z.infer<typeof acceptBody> }>(res)
    const key = attemptKey('/invites/accept', req.ip ?? 'unknown')
    if (deps.limiter.check(key) > 0) {
      await deps.audit.record({ action: 'auth.locked_out', actor: null, outcome: 'failure', detail: { path: '/invites/accept' } })
      throw new AppError(429, 'too_many_attempts', 'Too many attempts. Try again later.')
    }
    try {
      const accepted = await acceptInvite(deps.auth, deps.pool, body)
      deps.limiter.succeed(key)
      await deps.audit.record({ action: 'auth.invite_accepted', actor: accepted.userId, brandId: accepted.brandId, outcome: 'success' })
      res.status(201).json({ userId: accepted.userId })
    } catch (error) {
      deps.limiter.fail(key)
      await deps.audit.record({ action: 'auth.invite_accepted', actor: null, outcome: 'failure' })
      throw error
    }
  })
```

(import `AppError` from `../errors.ts`). Apply the same limit and audit to `/lookup`'s failures by calling `deps.limiter.fail(key)` when `lookupInvite` throws.

In `apps/core/src/api.ts` add `limiter: AttemptLimiter` and `audit: AuditSink` to `ApiDeps` and pass them to `inviteRoutes`. In `apps/core/src/core.ts` add `limiter?: AttemptLimiter` to `CoreDeps`, create `const limiter = deps.limiter ?? new AttemptLimiter({ maxFailures: LOCK_MAX_FAILURES, windowMs: LOCK_WINDOW_MS, lockMs: LOCK_DURATION_MS })`, and pass it (and `audit`) to `createAuth` and `createApiRouter`. In `apps/core/test/auth-schema-drift.test.ts` and `apps/core/src/auth/print-schema.ts` add `limiter: new AttemptLimiter({ maxFailures: 5, windowMs: 1, lockMs: 1 })` to the options they build. In the test support, `Stack` returns the `limiter` it built.

- [ ] **Step 6: Run to verify they pass**

Run (server): `npx vitest run apps/core`
Expected: PASS, including every earlier test. If a sign-in with the right password is recorded as a failure, or the `after` hook never sees the error, find how the pinned library hands the failed result to `after` hooks, use that, and record a ruling: the test above ("locks … even for the right one") is the check that it works.

- [ ] **Step 7: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps
git commit -m "feat(auth): lockout per address and per pending sign-in, and an audit entry for every attempt"
```

---

### Task 10: The running service, the record, and the pull request

**Files:**

- Create: `apps/core/src/adapters.ts`, `apps/core/src/server.ts`, `apps/core/src/main.ts`
- Modify: `apps/core/package.json` (script), `.env.example`, `docs/progress.md`
- Test: `apps/core/test/server.test.ts`

**Interfaces:**

- Consumes: everything above
- Produces:
  - `UnconfiguredMailer` (its `send` rejects with "Email delivery is not configured. It arrives with notification delivery (package 11).") and `LogAudit(logger)` (writes each entry to the logger at `info`, under `audit`) from `adapters.ts`
  - `startServer(config: Config, deps: { logger: Logger; mailer: Mailer; audit: AuditSink }): Promise<{ url: string; stop(): Promise<void> }>`: builds the two pools from `config.databaseUrl`, builds the core, listens on `config.port` (`0` picks a free port), and `stop()` closes the server and both pools
  - `npm run start --workspace @mkt/core` runs `main.ts`: loads the configuration from the environment, starts the server, and stops cleanly on `SIGTERM` and `SIGINT`

- [ ] **Step 1: Write the failing test**

`apps/core/test/server.test.ts`:

```ts
import { createTestDatabase } from '@mkt/db/testing'
import { requireDatabase } from '@mkt/test-support'
import { describe, expect, it } from 'vitest'
import { LogAudit, UnconfiguredMailer } from '../src/adapters.ts'
import { createLogger } from '../src/logger.ts'
import { startServer } from '../src/server.ts'

describe('adapters', () => {
  it('refuses to send mail until delivery is configured', async () => {
    await expect(new UnconfiguredMailer().send({ to: 'a@example.test', subject: 's', text: 't' })).rejects.toThrow(
      /not configured/,
    )
  })

  it('writes audit entries to the log', async () => {
    const lines: string[] = []
    const logger = createLogger('info', { write: (line: string) => void lines.push(line) })
    await new LogAudit(logger).record({ action: 'auth.sign_in', actor: null, outcome: 'success' })
    expect(lines.join('')).toContain('auth.sign_in')
  })
})

describe('startServer', () => {
  it('starts on a free port, reports ready against the database, and stops cleanly', async () => {
    await requireDatabase()
    const db = await createTestDatabase()
    const logger = createLogger('silent')
    const server = await startServer(
      {
        nodeEnv: 'test',
        port: 0,
        databaseUrl: db.urlFor('app'),
        authSecret: 'z'.repeat(48),
        publicOrigin: 'https://app.example.test',
        logLevel: 'silent',
      },
      { logger, mailer: new UnconfiguredMailer(), audit: new LogAudit(logger) },
    )
    try {
      expect((await fetch(`${server.url}/health/live`)).status).toBe(200)
      expect((await fetch(`${server.url}/health/ready`)).status).toBe(200)
      expect((await fetch(`${server.url}/api/v1/session`)).status).toBe(401)
    } finally {
      await server.stop()
      await db.drop()
    }
    await expect(fetch(`${server.url}/health/live`)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run (server): `npx vitest run apps/core/test/server.test.ts`
Expected: FAIL, `../src/adapters.ts` does not exist.

- [ ] **Step 3: Write the adapters, the server and the entry point**

`apps/core/src/adapters.ts`:

```ts
import type { Logger } from 'pino'
import type { AuditEntry, AuditSink, MailMessage, Mailer } from './ports.ts'

// Stands in until notification delivery (package 11). No invite or recovery mail can be sent before then.
export class UnconfiguredMailer implements Mailer {
  async send(_message: MailMessage): Promise<void> {
    throw new Error('Email delivery is not configured. It arrives with notification delivery (package 11).')
  }
}

// Stands in until the audit log (package 6). Entries hold a hash of an address, never the address.
export class LogAudit implements AuditSink {
  private readonly logger: Logger

  constructor(logger: Logger) {
    this.logger = logger
  }

  async record(entry: AuditEntry): Promise<void> {
    this.logger.info({ audit: entry }, 'audit')
  }
}
```

`apps/core/src/server.ts`:

```ts
import { createPool } from '@mkt/db'
import type { AddressInfo } from 'node:net'
import type { Logger } from 'pino'
import type { Config } from './config.ts'
import { buildCore } from './core.ts'
import type { AuditSink, Mailer } from './ports.ts'

export interface RunningServer {
  url: string
  stop(): Promise<void>
}

export async function startServer(
  config: Config,
  deps: { logger: Logger; mailer: Mailer; audit: AuditSink },
): Promise<RunningServer> {
  const appPool = createPool(config.databaseUrl)
  const authPool = createPool(config.databaseUrl, { searchPath: 'auth' })
  const { app } = buildCore({ config, logger: deps.logger, appPool, authPool, mailer: deps.mailer, audit: deps.audit })
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const listening = app.listen(config.port, () => resolve(listening))
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
      await appPool.end()
      await authPool.end()
    },
  }
}
```

`apps/core/src/main.ts`:

```ts
import { LogAudit, UnconfiguredMailer } from './adapters.ts'
import { loadConfig } from './config.ts'
import { createLogger } from './logger.ts'
import { startServer } from './server.ts'

const config = loadConfig(process.env)
const logger = createLogger(config.logLevel)
const server = await startServer(config, { logger, mailer: new UnconfiguredMailer(), audit: new LogAudit(logger) })
logger.info({ url: server.url }, 'core service started')

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'stopping')
    server.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
}
```

In `apps/core/package.json` set `"scripts": { "auth:schema": "node src/auth/print-schema.ts", "start": "node src/main.ts" }`.

Append to `.env.example` (read the file first and follow its style; these are placeholders, never real values):

```
# Core service (apps/core)
NODE_ENV=development
PORT=4000
DATABASE_URL=postgres://mkt_app:CHANGE_ME@127.0.0.1:54329/mkt_dev
AUTH_SECRET=CHANGE_ME_TO_A_RANDOM_VALUE_OF_AT_LEAST_32_CHARACTERS
PUBLIC_ORIGIN=https://stg.marketing.sarathi.gvcc.in
LOG_LEVEL=info
```

- [ ] **Step 4: Run to verify it passes, then the whole suite twice**

Run (server): `npx vitest run apps/core`
Expected: PASS.

Run (server), twice: `npm ci && npm run verify`
Expected both times: every step passes, including `npm run secrets`. Then confirm no test database is left behind: `ssh root@<dev-server> "docker exec mkt-dev-postgres-1 psql -U mkt -d postgres -Atc \"select count(*) from pg_database where datname like 'mkt_t_%'\""` Expected: `0`.

- [ ] **Step 5: Smoke the real process once**

Run (server): start the database if needed, then run the service for a moment against the development database as the application role. The role needs a login there: this step uses a throw-away database from the test harness, so run it as a one-off script instead:

```
/opt/mkt-dev/run.sh "node --input-type=module -e \"import('@mkt/db/testing').then(async ({createTestDatabase})=>{const {startServer}=await import('./apps/core/src/server.ts');const {createLogger}=await import('./apps/core/src/logger.ts');const {LogAudit,UnconfiguredMailer}=await import('./apps/core/src/adapters.ts');const db=await createTestDatabase();const logger=createLogger('silent');const s=await startServer({nodeEnv:'test',port:0,databaseUrl:db.urlFor('app'),authSecret:'z'.repeat(48),publicOrigin:'https://app.example.test',logLevel:'silent'},{logger,mailer:new UnconfiguredMailer(),audit:new LogAudit(logger)});console.log((await fetch(s.url+'/health/ready')).status);await s.stop();await db.drop()})\""
```

Expected: prints `200`. This proves the same entry path `main.ts` uses works under Node's own type stripping, not only under Vitest. If it fails on syntax (an enum, a parameter property), fix the source file; do not change the way the service is run.

- [ ] **Step 6: Record the milestone**

Append to `docs/progress.md` a section "Phase 1, milestone 2b: Core service and sign-in" with: the date; the commits; packages 3 and 4 done; the tests proven (8 through the API gate, 9, 10, 11, 12; the SEC-1 and no-self-registration checks), and what is not proven and why (13 is package 5; 1 and 6 need later code; the screen side of 8 waits for the dashboard); every ruling made, including any change to the generated SQL, the audit hook and the TOTP replay behaviour; the values proposed in this plan and which of them the owner confirmed; the five decisions above with the owner's answers; and the state plainly: no real email can be sent and the audit sink is the log until packages 11 and 6.

- [ ] **Step 7: Commit, push and open the pull request**

```
git add apps docs .env.example
git commit -m "feat(core): runnable service, adapters standing in for mail and audit, and the milestone 2b record"
git push -u origin m2b-core-and-sign-in
gh pr create --base main --head m2b-core-and-sign-in --title "Milestone 2b: core service and sign-in (packages 3 and 4)" --body-file <description>
```

Write the description with: what was added; the decisions awaiting the owner; the findings and rulings; what was run (the verify runs and the smoke); what is not proven. End it with the attribution line the session gives. Then wait for the workflow run on the pull request and confirm it succeeds. Do not merge: the owner reviews it.

- [ ] **Step 8: Report to the owner**

State what passed, each finding and ruling, the five decisions that need an answer, and anything that differs from this plan.
