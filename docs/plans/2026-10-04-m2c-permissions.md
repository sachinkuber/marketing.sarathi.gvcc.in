# Milestone 2c (Permissions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every core route declares the access it needs, the roles in the PRD access table are enforced exactly as the table states, and a brand admin or the platform owner can list, invite, change the role of, remove and (for the owner) reset the second factor of the people in a brand, each sensitive action asking for the actor's own six-digit code first.

**Architecture:** Routes are registered only through a `RouteTable`, which refuses a route that has no access declaration and builds the middleware chain for each kind of access (public, signed in, enrolled, platform owner, brand member, named permission). The role-to-permission matrix is data in one file, and a test parses the PRD table so the two cannot drift. Brand-scoped routes live under `/brands/:brandId`; a person who is not in that brand gets 404, so a brand ID is never an oracle. Sensitive actions carry the actor's current authenticator code in the request body and check it through the sign-in library's own TOTP check, so they share the per-account lockout and audit of sign-in. No migration and no new dependency.

**Tech Stack:** Node 24.20.0, TypeScript 5.9.3, Express 5.2.1, Zod 4.5.4, Better Auth 1.7.2, pg 8.23.0 through `@mkt/db`, PostgreSQL 17.11, Vitest 4.1.11.

**Spec:** `docs/specs/2026-10-04-phase-1-foundation.md` (version 5) sections 7, 8 and 18 (package 5) and acceptance tests 1 and 13. Roles and the access table: PRD 16.1 (`docs/prd/2026-10-03-ai-marketing-agency-prd.md`). User management flows: `docs/app-flow/2026-10-04-app-flow.md` sections 5.2 and 5.3. Earlier plans: `docs/plans/2026-10-04-m2b-core-service-and-sign-in.md` (its Scope lists what was left for this one).

## Scope

In this plan (package 5):

- The permission matrix and the test that ties it to the PRD (acceptance test 13, role half).
- The route table, with every existing route moved onto it (acceptance test 13, declaration half), and the brand access check.
- The generic cross-brand test over every brand-scoped route (acceptance test 1 for the routes that exist now; it applies itself to routes added later).
- The second-factor code check for sensitive actions.
- The first permissioned routes: brands (list the person's own, read one) and users (list with pending invites, invite, change role, remove, reset a second factor).
- Audit entries for permission changes (SEC-2: "sign-ins and permission changes are logged").

Not in this plan, and why:

- **Setting shadow mode, the kill switch and data export:** packages 12 and later. They will use the same table and the same code check ("the second factor is asked again before ... using the kill switch or exporting data").
- **The platform owner's list of all brands:** it needs the owner-view database role and an audit entry per call (spec section 6), which belong with the dashboard milestone. `GET /brands` lists the person's own brands only.
- **Real email delivery and the audit tables:** packages 11 and 6. Mail and audit stay ports.
- **Cancelling a pending invite:** not in the spec; an invite expires after 72 hours.

## Global Constraints

- Everything from the milestone 1, 2a and 2b plans still holds: exact pins, committed lockfile, no secret committed, n8n untouched, nothing installed on the owner's laptop, no server address written into the repository (write `root@<dev-server>`). Commands run on the development server (`/opt/mkt-dev/run.sh`) after an `rsync` of the project, as in the 2b plan.
- Source files run under Node's type stripping: no enums, no constructor parameter properties.
- **Permissions:** each row of the PRD 16.1 table is a named permission. Every core route declares the one it needs; a route with no declaration fails a test (SEC-2). Every permission is enforced on the server, not only hidden on screen.
- **Sensitive actions:** the second factor is asked again before changing roles, using the kill switch or exporting data. Changing a role, removing a user or resetting a second factor asks for the admin's own six-digit code first (app-flow 5.3).
- **Inviting:** a brand admin can invite only into their own brand and cannot create a platform owner.
- **Lost second factor:** if no backup code is left, the platform owner resets the user's second factor, which is audited and notified; the user enrols again at next sign-in (spec section 7, app-flow 5.2).
- **Isolation:** all brand data access passes through `withBrand`; application code never imports `pg`, `kysely` or `pg-boss`; the two named database functions `app.is_platform_owner` and `app.memberships_for_user` are the only reads across brands for one signed-in person.
- Mail fails open (a notification that cannot be sent is reported and never changes an answer); the audit sink fails closed (an attempt that cannot be recorded is refused). Both rulings come from milestone 2b.
- A password, a code, a token or an address must never reach the log or an audit entry; audit entries hold `emailHash`, never the address.
- The milestone is merged by the executor once its checks pass and its reviews are clean (owner's standing instruction, 2026-10-04); every ruling goes into the pull request and `docs/progress.md`.

## Decisions the owner confirmed (all seven accepted, 2026-10-04)

1. **Resetting a second factor is the platform owner's alone.** Spec section 7 and app-flow 5.2 say the platform owner resets it; app-flow 5.3 lists it among the actions of "platform owner, brand admin". The spec is binding, so a brand admin asks the owner. Proposed: follow the spec.
2. **Nobody can change or remove their own membership through these routes,** and the last brand admin of a brand cannot be demoted or removed (add another admin first). This stops a brand locking itself out. Proposed: accept.
3. **Only the platform owner can change or remove a platform owner's membership.** A brand admin who is also a platform owner cannot be demoted by another brand admin. Proposed: accept.
4. **Each sensitive action carries the actor's current six-digit code in the request** and no separate "recently verified" window exists. A code can be used for two actions inside its 30-second window (the library does not block replay). Proposed: accept.
5. **A person who is not in a brand gets 404, not 403,** for every route under that brand, so brand IDs cannot be probed. A member without the permission gets 403. The platform owner can open any brand that exists. Proposed: accept.
6. **Until real email arrives (package 11) no invite can really be sent:** the service's stand-in mailer refuses, so inviting answers 502 and leaves no invite behind. Tests use an in-memory mailer. Proposed: accept.
7. **Removing a person removes their membership in this brand only.** If they have no membership left (and are not the platform owner) their sessions end. Their account stays, because other tables refer to it. Proposed: accept.

## Review Focus

1. **A signed-in person naming a brand they are not in** gets 404 for every route under it, including routes they would be denied anyway, and a brand that does not exist looks the same as one they are not in. Tasks 2, 3 and 5.
2. **A route added without a declaration,** or a brand-scoped route declared outside `/brands/:brandId`, or a `/brands/:brandId` route declared with no brand access, fails. Tasks 2 and 3.
3. **Two admins demoting each other at the same moment** must not leave a brand with no admin. Task 7.
4. **A wrong code, another person's code, or a missing code** leaves the state unchanged, records no success, and counts against the acting person's lockout. Tasks 4, 7 and 8.
5. **A brand admin acting on a platform owner, on themselves, or through a `brandId` in the path that differs from the one the role was checked for.** Task 7.
6. **An audit sink that fails** must roll back the change it records (fail-closed), and the list of people must never contain a token hash, a password hash, or another brand's rows. Tasks 6 and 7.
7. **Resetting a second factor** must end that person's sessions, remove their backup codes, and make the next sign-in require enrolment again. Task 8.

---

### Task 1: The permission matrix, tied to the PRD

**Files:**

- Create: `apps/core/src/access/permissions.ts`
- Test: `apps/core/test/permissions.test.ts`

**Interfaces:**

- Consumes: nothing
- Produces:
  - `type Actor = 'platform_owner' | 'brand_admin' | 'approver' | 'sales_contact' | 'viewer'` and `ACTORS: readonly Actor[]`
  - `type Grant = 'all' | 'own' | false`
  - `PERMISSION_KEYS` and `type PermissionKey` (`see_other_brands`, `view_content`, `edit_profile`, `approve_content`, `approve_budgets`, `connect_accounts`, `manage_users`, `view_lead_data`, `export_delete_data`, `use_kill_switch`)
  - `PERMISSIONS: Record<PermissionKey, { label: string; grants: Record<Actor, Grant> }>` where `label` is the PRD row's exact text
  - `grantFor(actor: Actor, permission: PermissionKey): Grant`

- [ ] **Step 1: Write the failing test**

`apps/core/test/permissions.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTORS, PERMISSIONS, PERMISSION_KEYS, grantFor, type Grant } from '../src/access/permissions.ts'

const PRD = join(import.meta.dirname, '..', '..', '..', 'docs', 'prd', '2026-10-03-ai-marketing-agency-prd.md')

// The PRD's access table (section 16.1), read as written, so the code cannot drift from it.
function prdTable(): { header: string[]; rows: { label: string; cells: string[] }[] } {
  const lines = readFileSync(PRD, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.startsWith('| Permission | Platform owner |'))
  expect(start, 'the PRD access table was not found').toBeGreaterThan(-1)
  const cells = (line: string) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
  const rows: { label: string; cells: string[] }[] = []
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break
    const parts = cells(line)
    rows.push({ label: parts[0] as string, cells: parts.slice(1) })
  }
  return { header: cells(lines[start] as string), rows }
}

const FROM_PRD: Record<string, Grant> = { Yes: 'all', No: false, 'Own leads': 'own' }

describe('the permission matrix', () => {
  it('reads the PRD columns in the order the code assumes', () => {
    expect(prdTable().header).toEqual([
      'Permission',
      'Platform owner',
      'Brand admin',
      'Brand approver',
      'Sales contact',
      'Viewer',
      'Partner',
    ])
    expect(ACTORS).toEqual(['platform_owner', 'brand_admin', 'approver', 'sales_contact', 'viewer'])
  })

  it('has exactly the PRD rows, by their exact labels', () => {
    const labels = prdTable().rows.map((row) => row.label)
    expect(labels).toHaveLength(10)
    expect(PERMISSION_KEYS.map((key) => PERMISSIONS[key].label)).toEqual(labels)
  })

  it('grants every role exactly what the PRD table says (the partner has no account and is not a role)', () => {
    for (const row of prdTable().rows) {
      const key = PERMISSION_KEYS.find((candidate) => PERMISSIONS[candidate].label === row.label)
      expect(key, row.label).toBeDefined()
      ACTORS.forEach((actor, index) => {
        const cell = row.cells[index] as string
        expect(FROM_PRD[cell], `${row.label} / ${actor}: "${cell}" is not a value this test understands`).not.toBeUndefined()
        expect(grantFor(actor, key!), `${row.label} / ${actor}`).toBe(FROM_PRD[cell])
      })
    }
  })

  it('lets only the platform owner see other brands, and a sales contact see only their own leads', () => {
    expect(ACTORS.filter((actor) => grantFor(actor, 'see_other_brands'))).toEqual(['platform_owner'])
    expect(grantFor('sales_contact', 'view_lead_data')).toBe('own')
    expect(grantFor('viewer', 'manage_users')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run (server): `npx vitest run apps/core/test/permissions.test.ts`
Expected: FAIL, `../src/access/permissions.ts` does not exist.

- [ ] **Step 3: Write the matrix**

`apps/core/src/access/permissions.ts`:

```ts
// PRD 16.1. Each row of the access table is a named permission; `label` is the row's exact text, and a
// test reads the PRD table to prove this file says what it says. The partner has no account (the access
// is a single-purpose link), so it is not an actor here.
export type Actor = 'platform_owner' | 'brand_admin' | 'approver' | 'sales_contact' | 'viewer'

export const ACTORS: readonly Actor[] = [
  'platform_owner',
  'brand_admin',
  'approver',
  'sales_contact',
  'viewer',
]

// 'own' is a narrower grant: a sales contact sees only their own leads. Routes that need it read the grant.
export type Grant = 'all' | 'own' | false

export const PERMISSION_KEYS = [
  'see_other_brands',
  'view_content',
  'edit_profile',
  'approve_content',
  'approve_budgets',
  'connect_accounts',
  'manage_users',
  'view_lead_data',
  'export_delete_data',
  'use_kill_switch',
] as const

export type PermissionKey = (typeof PERMISSION_KEYS)[number]

interface PermissionDefinition {
  label: string
  grants: Record<Actor, Grant>
}

const everyoneButSales = { platform_owner: 'all', brand_admin: 'all', approver: 'all', sales_contact: false } as const

export const PERMISSIONS: Record<PermissionKey, PermissionDefinition> = {
  see_other_brands: {
    label: 'See other brands',
    grants: { platform_owner: 'all', brand_admin: false, approver: false, sales_contact: false, viewer: false },
  },
  view_content: {
    label: 'View brand content and reports',
    grants: { ...everyoneButSales, viewer: 'all' },
  },
  edit_profile: {
    label: 'Edit profile and verified facts',
    grants: { platform_owner: 'all', brand_admin: 'all', approver: false, sales_contact: false, viewer: false },
  },
  approve_content: {
    label: 'Approve content',
    grants: { ...everyoneButSales, viewer: false },
  },
  approve_budgets: {
    label: 'Approve budgets',
    grants: { platform_owner: 'all', brand_admin: 'all', approver: false, sales_contact: false, viewer: false },
  },
  connect_accounts: {
    label: 'Connect or disconnect accounts',
    grants: { platform_owner: 'all', brand_admin: 'all', approver: false, sales_contact: false, viewer: false },
  },
  manage_users: {
    label: 'Manage users',
    grants: { platform_owner: 'all', brand_admin: 'all', approver: false, sales_contact: false, viewer: false },
  },
  view_lead_data: {
    label: 'View lead personal data',
    grants: { platform_owner: 'all', brand_admin: 'all', approver: false, sales_contact: 'own', viewer: false },
  },
  export_delete_data: {
    label: 'Export or delete data',
    grants: { platform_owner: 'all', brand_admin: 'all', approver: false, sales_contact: false, viewer: false },
  },
  use_kill_switch: {
    label: 'Use the kill switch',
    grants: { platform_owner: 'all', brand_admin: 'all', approver: false, sales_contact: false, viewer: false },
  },
}

export function grantFor(actor: Actor, permission: PermissionKey): Grant {
  return PERMISSIONS[permission].grants[actor]
}
```

- [ ] **Step 4: Run to verify it passes**

Run (server): `npx vitest run apps/core/test/permissions.test.ts`
Expected: PASS, 4 tests. If the PRD table has changed since this plan was written, the test names the row and column that differ: fix `permissions.ts`, never the test.

- [ ] **Step 5: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`
Expected: all pass (run `npx prettier --write` on a file it names and copy it back).

```
git add apps/core
git commit -m "feat(access): the role and permission matrix, with a test that reads the PRD table"
```

---

### Task 2: The route table and the brand access check

**Files:**

- Create: `apps/core/src/access/routes.ts`, `apps/core/src/access/brand-access.ts`, `apps/core/src/access/inspect.ts`
- Modify: `apps/core/src/api.ts`, `apps/core/src/routes/invites.ts`, `apps/core/src/core.ts`, `apps/core/test/support.ts`
- Test: `apps/core/test/route-table.test.ts`, `apps/core/test/access-kinds.test.ts`

**Interfaces:**

- Consumes: `grantFor`, `PermissionKey`, `Actor`, `Grant` (Task 1); `loadPrincipal`, `enrolmentGate`, `principalOf` (`auth/session.ts`); `withBrand`
- Produces:
  - `type Access = { kind: 'public' } | { kind: 'signed_in' } | { kind: 'enrolled' } | { kind: 'platform_owner' } | { kind: 'member' } | { kind: 'permission'; permission: PermissionKey }`
  - `class RouteTable` with `add(route: { method: 'get' | 'post' | 'patch' | 'delete'; path: string; access: Access; summary: string; handlers: RequestHandler[] }): void`, `list(): readonly RouteDeclaration[]`, `build(deps: { auth: Auth; pool: Pool }): Router`. `add` throws on a route declared twice, on a `member` or `permission` route whose path does not contain `/brands/:brandId`, and on any other kind whose path contains `:brandId`.
  - What each kind means: `public` (no session), `signed_in` (a session, enrolment not required: only `GET /session`), `enrolled` (a session and a finished enrolment where one is required), `platform_owner` (enrolled and the platform owner, else 403), `member` (enrolled and a member of `:brandId` or the platform owner; else 404), `permission` (a member whose role holds the permission, else 403; a non-member gets 404).
  - `brandAccess(pool, permission | null): RequestHandler` and `brandContextOf(res): { brandId: string; actor: Actor; grant: Grant }`
  - `undeclaredRoutes(router: Router, table: RouteTable): string[]` (entries like `GET /x`) from `inspect.ts`, for tests
  - `createApi(deps: ApiDeps, extra?: (table: RouteTable, context: { auth: Auth; pool: Pool }) => void): { router: Router; table: RouteTable }` in `api.ts`; `buildCore` returns `{ app, auth, api, routes }` and `CoreDeps` gains `extraRoutes?: (table, context) => void` (a test seam: tests declare probe routes; production leaves it unset)
  - From `test/support.ts`: `createStack({ extraRoutes })`, `signedInClient(stack, email, password): Promise<TestClient>`, `enrolledClient(stack, email, password): Promise<{ client: TestClient; secret: string }>`

- [ ] **Step 1: Write the failing tests**

`apps/core/test/route-table.test.ts`:

```ts
import type { RequestHandler } from 'express'
import { describe, expect, it } from 'vitest'
import { RouteTable } from '../src/access/routes.ts'

const ok: RequestHandler = (_req, res) => {
  res.json({ ok: true })
}

describe('RouteTable', () => {
  it('refuses a brand-scoped route that is not under /brands/:brandId', () => {
    const table = new RouteTable()
    expect(() =>
      table.add({ method: 'get', path: '/things', access: { kind: 'member' }, summary: 'x', handlers: [ok] }),
    ).toThrow(/under \/brands\/:brandId/)
    expect(() =>
      table.add({
        method: 'get',
        path: '/things',
        access: { kind: 'permission', permission: 'manage_users' },
        summary: 'x',
        handlers: [ok],
      }),
    ).toThrow(/under \/brands\/:brandId/)
  })

  it('refuses a /brands/:brandId route declared as anything but member or a permission', () => {
    const table = new RouteTable()
    for (const kind of ['public', 'signed_in', 'enrolled', 'platform_owner'] as const) {
      expect(() =>
        table.add({ method: 'get', path: '/brands/:brandId/x', access: { kind }, summary: 'x', handlers: [ok] }),
      ).toThrow(/member or a permission/)
    }
  })

  it('refuses a route declared twice, and a route with no handler or no summary', () => {
    const table = new RouteTable()
    const route = { method: 'get', path: '/a', access: { kind: 'public' }, summary: 'a', handlers: [ok] } as const
    table.add({ ...route, handlers: [ok] })
    expect(() => table.add({ ...route, handlers: [ok] })).toThrow(/declared twice/)
    expect(() => table.add({ ...route, path: '/b', handlers: [] })).toThrow(/no handler/)
    expect(() => table.add({ ...route, path: '/c', summary: '  ' })).toThrow(/summary/)
  })

  it('lists what was declared', () => {
    const table = new RouteTable()
    table.add({ method: 'post', path: '/a', access: { kind: 'public' }, summary: 'a', handlers: [ok] })
    expect(table.list().map((r) => `${r.method} ${r.path}`)).toEqual(['post /a'])
  })
})
```

`apps/core/test/access-kinds.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBrand, addUser, createStack, enrolledClient, signedInClient, type Stack } from './support.ts'
import type { TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
const RANDOM = '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b'

describe('what each kind of access lets through', () => {
  let stack: Stack
  let brandA: string
  let brandB: string
  let unenrolled: TestClient
  let approver: TestClient
  let viewer: TestClient
  let owner: TestClient

  beforeAll(async () => {
    stack = await createStack({
      extraRoutes: (table) => {
        const probe = (path: string, access: Parameters<typeof table.add>[0]['access']) =>
          table.add({
            method: 'get',
            path,
            access,
            summary: 'probe',
            handlers: [
              (_req, res) => {
                res.json({ ok: true })
              },
            ],
          })
        probe('/_probe/public', { kind: 'public' })
        probe('/_probe/signed_in', { kind: 'signed_in' })
        probe('/_probe/enrolled', { kind: 'enrolled' })
        probe('/_probe/platform_owner', { kind: 'platform_owner' })
        probe('/brands/:brandId/_probe/member', { kind: 'member' })
      },
    })
    brandA = await addBrand(stack, 'brand-a')
    brandB = await addBrand(stack, 'brand-b')
    await addUser(stack, { email: 'unenrolled@example.test', password: PASSWORD, role: 'approver', brandId: brandA })
    await addUser(stack, { email: 'approver@example.test', password: PASSWORD, role: 'approver', brandId: brandA })
    await addUser(stack, { email: 'viewer@example.test', password: PASSWORD, role: 'viewer', brandId: brandA })
    await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
    unenrolled = await signedInClient(stack, 'unenrolled@example.test', PASSWORD)
    approver = (await enrolledClient(stack, 'approver@example.test', PASSWORD)).client
    viewer = await signedInClient(stack, 'viewer@example.test', PASSWORD)
    owner = (await enrolledClient(stack, 'owner@example.test', PASSWORD)).client
  })
  afterAll(async () => stack?.close())

  const get = (client: TestClient, path: string) => client.request('GET', path)

  it('public: anyone, with no session', async () => {
    expect((await get(stack.newClient(), '/api/v1/_probe/public')).status).toBe(200)
  })

  it('signed_in: needs a session but not a finished enrolment', async () => {
    expect((await get(stack.newClient(), '/api/v1/_probe/signed_in')).status).toBe(401)
    expect((await get(unenrolled, '/api/v1/_probe/signed_in')).status).toBe(200)
  })

  it('enrolled: needs a session and, where required, a second factor', async () => {
    expect((await get(stack.newClient(), '/api/v1/_probe/enrolled')).status).toBe(401)
    const blocked = await get(unenrolled, '/api/v1/_probe/enrolled')
    expect(blocked.status).toBe(403)
    expect(blocked.json.error.code).toBe('enrolment_required')
    expect((await get(viewer, '/api/v1/_probe/enrolled')).status).toBe(200)
    expect((await get(approver, '/api/v1/_probe/enrolled')).status).toBe(200)
  })

  it('platform_owner: only the platform owner', async () => {
    expect((await get(stack.newClient(), '/api/v1/_probe/platform_owner')).status).toBe(401)
    expect((await get(viewer, '/api/v1/_probe/platform_owner')).status).toBe(403)
    expect((await get(approver, '/api/v1/_probe/platform_owner')).status).toBe(403)
    expect((await get(owner, '/api/v1/_probe/platform_owner')).status).toBe(200)
  })

  it('member: a member of that brand, or the platform owner for any brand that exists; otherwise 404', async () => {
    const path = (brand: string) => `/api/v1/brands/${brand}/_probe/member`
    expect((await get(stack.newClient(), path(brandA))).status).toBe(401)
    expect((await get(unenrolled, path(brandA))).status).toBe(403)
    expect((await get(approver, path(brandA))).status).toBe(200)
    expect((await get(viewer, path(brandA))).status).toBe(200)
    // Not a member of brand B: 404, the same answer as for a brand that does not exist or an ID that is not one.
    const other = await get(approver, path(brandB))
    expect(other.status).toBe(404)
    expect((await get(approver, path(RANDOM))).status).toBe(404)
    expect((await get(approver, path('not-a-uuid'))).status).toBe(404)
    expect((await get(approver, path(RANDOM))).json).toEqual(other.json)
    // The platform owner has no membership anywhere and can open any brand that exists.
    expect((await get(owner, path(brandB))).status).toBe(200)
    expect((await get(owner, path(RANDOM))).status).toBe(404)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run (server): `npx vitest run apps/core/test/route-table.test.ts apps/core/test/access-kinds.test.ts`
Expected: FAIL, `../src/access/routes.ts` does not exist (and `signedInClient`, `enrolledClient` are not exported by `support.ts`).

- [ ] **Step 3: Write the brand access check**

`apps/core/src/access/brand-access.ts`:

```ts
import { withBrand, type Pool } from '@mkt/db'
import type { RequestHandler, Response } from 'express'
import { principalOf } from '../auth/session.ts'
import { AppError } from '../errors.ts'
import { grantFor, type Actor, type Grant, type PermissionKey } from './permissions.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface BrandContext {
  brandId: string
  actor: Actor
  grant: Grant
}

export function brandContextOf(res: Response): BrandContext {
  return res.locals.brand as BrandContext
}

// 404, not 403, for a brand the person is not in: a brand ID must not tell anyone whether the brand exists.
const NOT_FOUND = () => new AppError(404, 'not_found', 'There is nothing at this address.')

// Runs after the principal is loaded. `permission` null means any member (or the platform owner) will do.
// The role is the person's role in THIS brand, taken from the brand in the path, never from anything else.
export function brandAccess(pool: Pool, permission: PermissionKey | null): RequestHandler {
  return async (req, res, next) => {
    const brandId = req.params.brandId
    if (typeof brandId !== 'string' || !UUID.test(brandId)) throw NOT_FOUND()
    const principal = principalOf(res)
    const membership = principal.memberships.find((m) => m.brandId === brandId)
    const actor: Actor | null = principal.isPlatformOwner ? 'platform_owner' : (membership?.role ?? null)
    if (!actor) throw NOT_FOUND()
    if (principal.isPlatformOwner && !membership) {
      // The owner may open any brand that exists; one that does not looks like any other missing address.
      const found = await withBrand(pool, brandId, (client) => client.query('select 1 from app.brand'))
      if (found.rowCount === 0) throw NOT_FOUND()
    }
    const grant: Grant = permission ? grantFor(actor, permission) : 'all'
    if (!grant) throw new AppError(403, 'forbidden', 'You do not have permission to do this.')
    const context: BrandContext = { brandId, actor, grant }
    res.locals.brand = context
    next()
  }
}
```

- [ ] **Step 4: Write the route table and the inspection helper**

`apps/core/src/access/routes.ts`:

```ts
import type { Pool } from '@mkt/db'
import { Router, type RequestHandler } from 'express'
import type { Auth } from '../auth/options.ts'
import { enrolmentGate, loadPrincipal, principalOf } from '../auth/session.ts'
import { AppError } from '../errors.ts'
import { brandAccess } from './brand-access.ts'
import type { PermissionKey } from './permissions.ts'

// What a route needs. Every route says so; there is no default.
export type Access =
  | { kind: 'public' }
  | { kind: 'signed_in' }
  | { kind: 'enrolled' }
  | { kind: 'platform_owner' }
  | { kind: 'member' }
  | { kind: 'permission'; permission: PermissionKey }

export type Method = 'get' | 'post' | 'patch' | 'delete'

export interface RouteDeclaration {
  method: Method
  path: string
  access: Access
  summary: string
  handlers: RequestHandler[]
}

const requirePlatformOwner: RequestHandler = (_req, res, next) => {
  if (!principalOf(res).isPlatformOwner) {
    throw new AppError(403, 'forbidden', 'You do not have permission to do this.')
  }
  next()
}

// The only way a route reaches the service. Nothing else holds the router, so a route without a declaration
// cannot exist (SEC-2), and a brand-scoped route cannot be written without the brand check.
export class RouteTable {
  private readonly routes: RouteDeclaration[] = []

  add(route: RouteDeclaration): void {
    const where = `${route.method} ${route.path}`
    const brandScoped = route.access.kind === 'member' || route.access.kind === 'permission'
    if (brandScoped && !route.path.includes('/brands/:brandId')) {
      throw new Error(`${where}: a member or permission route must live under /brands/:brandId`)
    }
    if (!brandScoped && route.path.includes(':brandId')) {
      throw new Error(`${where}: a route with :brandId must be declared as member or a permission`)
    }
    if (route.handlers.length === 0) throw new Error(`${where}: no handler`)
    if (route.summary.trim() === '') throw new Error(`${where}: a summary is required`)
    if (this.routes.some((r) => r.method === route.method && r.path === route.path)) {
      throw new Error(`${where}: declared twice`)
    }
    this.routes.push(route)
  }

  list(): readonly RouteDeclaration[] {
    return this.routes
  }

  build(deps: { auth: Auth; pool: Pool }): Router {
    const router = Router()
    const principal = loadPrincipal(deps.auth, deps.pool)
    for (const route of this.routes) {
      const chain: RequestHandler[] = []
      switch (route.access.kind) {
        case 'public':
          break
        case 'signed_in':
          chain.push(principal)
          break
        case 'enrolled':
          chain.push(principal, enrolmentGate)
          break
        case 'platform_owner':
          chain.push(principal, enrolmentGate, requirePlatformOwner)
          break
        case 'member':
          chain.push(principal, enrolmentGate, brandAccess(deps.pool, null))
          break
        case 'permission':
          chain.push(principal, enrolmentGate, brandAccess(deps.pool, route.access.permission))
          break
      }
      router[route.method](route.path, ...chain, ...route.handlers)
    }
    // Fail safe: anything registered on this router after it was built (a test's probe, a mistake) is
    // still behind a session and a finished enrolment.
    router.use(principal, enrolmentGate)
    return router
  }
}
```

`apps/core/src/access/inspect.ts`:

```ts
import type { Router } from 'express'
import type { RouteTable } from './routes.ts'

interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean> }
}

// Every route Express holds on this router, as "GET /path".
export function registeredRoutes(router: Router): string[] {
  const layers = (router as unknown as { stack: RouterLayer[] }).stack
  const found: string[] = []
  for (const layer of layers) {
    if (!layer.route) continue
    for (const method of Object.keys(layer.route.methods)) found.push(`${method.toUpperCase()} ${layer.route.path}`)
  }
  return found.sort()
}

// Routes on the router that nobody declared in the table. Empty in a healthy service (acceptance test 13).
export function undeclaredRoutes(router: Router, table: RouteTable): string[] {
  const declared = new Set(table.list().map((r) => `${r.method.toUpperCase()} ${r.path}`))
  return registeredRoutes(router).filter((key) => !declared.has(key))
}
```

- [ ] **Step 5: Move the existing routes onto the table**

Replace `apps/core/src/api.ts` with:

```ts
import type { Pool } from '@mkt/db'
import type { Router } from 'express'
import { RouteTable } from './access/routes.ts'
import { principalOf } from './auth/session.ts'
import type { AttemptLimiter } from './auth/limiter.ts'
import type { Auth } from './auth/options.ts'
import { csrfTokenFor } from './guard.ts'
import type { AuditSink } from './ports.ts'
import { registerInviteRoutes } from './routes/invites.ts'

export interface ApiDeps {
  auth: Auth
  pool: Pool
  secret: string
  limiter: AttemptLimiter
  audit: AuditSink
}

export interface ApiContext {
  auth: Auth
  pool: Pool
}

// Every route of the service is declared here, through the table, and nowhere else.
export function createApi(
  deps: ApiDeps,
  extra?: (table: RouteTable, context: ApiContext) => void,
): { router: Router; table: RouteTable } {
  const table = new RouteTable()

  table.add({
    method: 'get',
    path: '/session',
    access: { kind: 'signed_in' },
    summary: 'The signed-in person, their memberships and the request token',
    handlers: [
      (_req, res) => {
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
      },
    ],
  })

  registerInviteRoutes(table, {
    auth: deps.auth,
    pool: deps.pool,
    limiter: deps.limiter,
    audit: deps.audit,
  })

  extra?.(table, { auth: deps.auth, pool: deps.pool })
  return { router: table.build({ auth: deps.auth, pool: deps.pool }), table }
}
```

In `apps/core/src/routes/invites.ts`, replace the `Router` import with `import type { RouteTable } from '../access/routes.ts'`, rename `inviteRoutes` to `registerInviteRoutes(table: RouteTable, deps: { auth; pool; limiter; audit }): void`, and turn its two `router.post(...)` calls into declarations that keep their handler bodies exactly as they are:

```ts
  table.add({
    method: 'post',
    path: '/invites/lookup',
    access: { kind: 'public' },
    summary: 'Show an invited person their email, role and brand',
    handlers: [validate({ body: lookupBody }), async (req, res) => { /* the existing lookup handler body */ }],
  })
  table.add({
    method: 'post',
    path: '/invites/accept',
    access: { kind: 'public' },
    summary: 'Accept an invite: make the account and the membership',
    handlers: [validate({ body: acceptBody }), async (req, res) => { /* the existing accept handler body */ }],
  })
```

(The handler bodies are moved unchanged; only the registration changes. Remove the final `return router`.)

In `apps/core/src/core.ts`: import `createApi` instead of `createApiRouter` and `RouteTable`; add to `CoreDeps` an optional `extraRoutes?: (table: RouteTable, context: { auth: Auth; pool: Pool }) => void`; replace the `createApiRouter` call with:

```ts
  const { router: api, table: routes } = createApi(
    { auth, pool: deps.appPool, secret: config.authSecret, limiter, audit: deps.audit },
    deps.extraRoutes,
  )
```

and return `{ app, auth, api, routes }` (the return type becomes `{ app: Express; auth: Auth; api: Router; routes: RouteTable }`).

- [ ] **Step 6: Add the test helpers**

In `apps/core/test/support.ts`: add `extraRoutes?: CoreDeps['extraRoutes']` to the `createStack` options and pass it through to `buildCore`; add `routes` to what `Stack` exposes only through `core` (already there); and append:

```ts
// A client signed in with email and password, with no second factor set up.
export async function signedInClient(stack: Stack, email: string, password: string): Promise<TestClient> {
  const client = stack.newClient()
  const reply = await client.signIn(email, password)
  if (reply.status !== 200) throw new Error(`sign-in failed: ${reply.status} ${reply.text}`)
  return client
}

// A client signed in and enrolled: it can pass the enrolment gate and knows its authenticator secret.
export async function enrolledClient(
  stack: Stack,
  email: string,
  password: string,
): Promise<{ client: TestClient; secret: string }> {
  const client = await signedInClient(stack, email, password)
  const { secret } = await enrol(client, password)
  return { client, secret }
}
```

(`CoreDeps` is imported from `../src/core.ts` in `support.ts`.)

- [ ] **Step 7: Run to verify they pass**

Run (server): `npx vitest run apps/core`
Expected: PASS for the whole of `apps/core`, including every earlier test: the routes moved onto the table, and the older tests that add a `/test-protected` route to `stack.core.api` still see it behind the gate (the fail-safe `router.use` in `build`). If an older test imports `inviteRoutes` or `createApiRouter` directly, update the import and name the file in your report.

- [ ] **Step 8: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps/core
git commit -m "feat(access): every route is declared in a table; brand routes get the brand check, and a stranger gets 404"
```

---

### Task 3: Acceptance test 13: every route is declared, and each role is allowed and denied as the PRD says

**Files:**

- Test: `apps/core/test/route-declarations.test.ts`, `apps/core/test/role-matrix.test.ts`

**Interfaces:**

- Consumes: `undeclaredRoutes` (Task 2), `PERMISSION_KEYS`, `ACTORS`, `grantFor` (Task 1), `createStack({ extraRoutes })`, `enrolledClient`, `signedInClient`
- Produces: the two generic tests. They need no change when later packages add routes: the declaration test covers every route in the table, and the role-matrix test uses one probe route per permission.

- [ ] **Step 1: Write the declaration test**

`apps/core/test/route-declarations.test.ts`:

```ts
import { Router } from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { undeclaredRoutes } from '../src/access/inspect.ts'
import { RouteTable } from '../src/access/routes.ts'
import { createStack, type Stack } from './support.ts'

describe('every route declares the access it needs (acceptance test 13, SEC-2)', () => {
  let stack: Stack
  beforeAll(async () => {
    stack = await createStack()
  })
  afterAll(async () => stack?.close())

  it('has a declaration, with a summary, for every route the service holds', () => {
    expect(stack.core.routes.list().length).toBeGreaterThan(0)
    for (const route of stack.core.routes.list()) {
      expect(route.summary.trim(), `${route.method} ${route.path}`).not.toBe('')
      expect(route.access.kind, `${route.method} ${route.path}`).toBeDefined()
    }
    expect(undeclaredRoutes(stack.core.api, stack.core.routes)).toEqual([])
  })

  it('notices a route that was added without a declaration', () => {
    const router = Router()
    const table = new RouteTable()
    table.add({
      method: 'get',
      path: '/declared',
      access: { kind: 'public' },
      summary: 'x',
      handlers: [(_req, res) => void res.json({})],
    })
    router.get('/declared', (_req, res) => void res.json({}))
    router.post('/sneaked-in', (_req, res) => void res.json({}))
    expect(undeclaredRoutes(router, table)).toEqual(['POST /sneaked-in'])
  })

  it('has no public route except the ones that must be open to someone with no session', () => {
    const open = stack.core.routes
      .list()
      .filter((r) => r.access.kind === 'public')
      .map((r) => `${r.method} ${r.path}`)
      .sort()
    expect(open).toEqual(['post /invites/accept', 'post /invites/lookup'])
  })
})
```

- [ ] **Step 2: Write the role-matrix test**

`apps/core/test/role-matrix.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ACTORS, PERMISSION_KEYS, grantFor, type Actor } from '../src/access/permissions.ts'
import { addBrand, addUser, createStack, enrolledClient, signedInClient, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
const RANDOM = '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b'

// Each role is allowed and denied exactly as PRD 16.1 states, for every permission, over HTTP. One probe
// route per permission stands in for the real routes, which are checked for declaration by the other file.
describe('each role is allowed and denied as the PRD access table states (acceptance test 13)', () => {
  let stack: Stack
  let brand: string
  let otherBrand: string
  const clients = new Map<Actor, TestClient>()

  beforeAll(async () => {
    stack = await createStack({
      extraRoutes: (table) => {
        for (const permission of PERMISSION_KEYS) {
          table.add({
            method: 'get',
            path: `/brands/:brandId/_probe/${permission}`,
            access: { kind: 'permission', permission },
            summary: `probe for ${permission}`,
            handlers: [(_req, res) => void res.json({ ok: true })],
          })
        }
      },
    })
    brand = await addBrand(stack, 'brand-a')
    otherBrand = await addBrand(stack, 'brand-b')
    await addUser(stack, { email: 'admin@example.test', password: PASSWORD, role: 'brand_admin', brandId: brand })
    await addUser(stack, { email: 'approver@example.test', password: PASSWORD, role: 'approver', brandId: brand })
    await addUser(stack, { email: 'sales@example.test', password: PASSWORD, role: 'sales_contact', brandId: brand })
    await addUser(stack, { email: 'viewer@example.test', password: PASSWORD, role: 'viewer', brandId: brand })
    await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
    clients.set('brand_admin', (await enrolledClient(stack, 'admin@example.test', PASSWORD)).client)
    clients.set('approver', (await enrolledClient(stack, 'approver@example.test', PASSWORD)).client)
    clients.set('sales_contact', (await enrolledClient(stack, 'sales@example.test', PASSWORD)).client)
    clients.set('viewer', await signedInClient(stack, 'viewer@example.test', PASSWORD))
    clients.set('platform_owner', (await enrolledClient(stack, 'owner@example.test', PASSWORD)).client)
  })
  afterAll(async () => stack?.close())

  it('has a client for every role the matrix names', () => {
    expect([...clients.keys()].sort()).toEqual([...ACTORS].sort())
  })

  for (const permission of PERMISSION_KEYS) {
    it(`${permission}: allowed for the roles the PRD grants it to, 403 for the rest`, async () => {
      for (const actor of ACTORS) {
        const reply = await clients.get(actor)!.request('GET', `/api/v1/brands/${brand}/_probe/${permission}`)
        const expected = grantFor(actor, permission) ? 200 : 403
        expect(reply.status, `${actor} / ${permission}`).toBe(expected)
      }
    })
  }

  it('answers 404, not 403, to everyone who is not in the brand, for every permission', async () => {
    for (const permission of PERMISSION_KEYS) {
      for (const actor of ACTORS.filter((a) => a !== 'platform_owner')) {
        const reply = await clients.get(actor)!.request('GET', `/api/v1/brands/${otherBrand}/_probe/${permission}`)
        expect(reply.status, `${actor} / ${permission}`).toBe(404)
      }
    }
  })

  it('lets the platform owner into any brand that exists, and gives a brand that does not exist a 404', async () => {
    const owner = clients.get('platform_owner')!
    expect((await owner.request('GET', `/api/v1/brands/${otherBrand}/_probe/manage_users`)).status).toBe(200)
    expect((await owner.request('GET', `/api/v1/brands/${RANDOM}/_probe/manage_users`)).status).toBe(404)
  })
})
```

- [ ] **Step 3: Run them**

Run (server): `npx vitest run apps/core/test/route-declarations.test.ts apps/core/test/role-matrix.test.ts`
Expected: PASS. These tests exercise code from Task 2, so they pass on first run; take the RED evidence by temporarily changing one cell of the matrix in `permissions.ts` (for example giving `viewer` `manage_users`) and confirming the role-matrix test and the Task 1 PRD test both fail, then restore it. Report that run.

- [ ] **Step 4: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps/core
git commit -m "test(access): every route is declared; each role is allowed and denied as the PRD access table states"
```

---

### Task 4: The second-factor code check for sensitive actions

**Files:**

- Create: `apps/core/src/access/step-up.ts`
- Test: `apps/core/test/step-up.test.ts`

**Interfaces:**

- Consumes: `Auth`, `AppError`, `createStack({ extraRoutes })` with `ApiContext` (Task 2), `enrolledClient`, `totp`
- Produces: `verifySecondFactorCode(auth: Auth, req: Request, code: string): Promise<void>`. It checks the code against the signed-in person's own authenticator through the library's `verifyTOTP`, so the per-account lockout and the audit entry of sign-in apply to it. A wrong code throws `AppError(403, 'second_factor_invalid')`; a locked account throws `AppError(429, 'too_many_attempts')`. A route calls it before it changes anything.

- [ ] **Step 1: Write the failing test**

`apps/core/test/step-up.test.ts`:

```ts
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifySecondFactorCode } from '../src/access/step-up.ts'
import { inputOf, validate } from '../src/validate.ts'
import { addBrand, addUser, createStack, enrolledClient, totp, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
const body = z.strictObject({ code: z.string().regex(/^\d{6}$/) })

describe('asking for the second-factor code before a sensitive action', () => {
  let stack: Stack
  let brand: string
  let admin: TestClient
  let secret: string
  const act = (code: unknown) =>
    admin.request('POST', `/api/v1/brands/${brand}/_probe/step-up`, { body: { code } })

  beforeAll(async () => {
    stack = await createStack({
      extraRoutes: (table, context) => {
        table.add({
          method: 'post',
          path: '/brands/:brandId/_probe/step-up',
          access: { kind: 'permission', permission: 'manage_users' },
          summary: 'probe for the code check',
          handlers: [
            validate({ body }),
            async (req, res) => {
              await verifySecondFactorCode(context.auth, req, inputOf<{ body: { code: string } }>(res).body.code)
              res.json({ ok: true })
            },
          ],
        })
      },
    })
    brand = await addBrand(stack, 'brand-a')
    await addUser(stack, { email: 'admin@example.test', password: PASSWORD, role: 'brand_admin', brandId: brand })
    ;({ client: admin, secret } = await enrolledClient(stack, 'admin@example.test', PASSWORD))
  })
  afterAll(async () => stack?.close())

  it('lets the action through with the signed-in person’s current code', async () => {
    expect((await act(totp(secret))).status).toBe(200)
  })

  it('refuses a missing or malformed code before the check, and a wrong code with 403', async () => {
    expect((await act(undefined)).status).toBe(400)
    expect((await act('12345')).status).toBe(400)
    const wrong = await act('000000')
    expect(wrong.status).toBe(403)
    expect(wrong.json.error.code).toBe('second_factor_invalid')
  })

  it('refuses another person’s code', async () => {
    await addUser(stack, { email: 'other@example.test', password: PASSWORD, role: 'brand_admin', brandId: brand })
    const other = await enrolledClient(stack, 'other@example.test', PASSWORD)
    const reply = await act(totp(other.secret))
    expect(reply.status).toBe(403)
    expect(reply.json.error.code).toBe('second_factor_invalid')
  })

  it('counts wrong codes against the account’s lockout, and then refuses even the right code', async () => {
    // A right code clears the count the earlier tests in this file left, so exactly five wrong ones lock it.
    expect((await act(totp(secret))).status).toBe(200)
    stack.audit.entries.length = 0
    for (let i = 0; i < 5; i++) expect((await act('000000')).status).toBe(403)
    const locked = await act(totp(secret))
    expect(locked.status).toBe(429)
    expect(locked.json.error.code).toBe('too_many_attempts')
    const failures = stack.audit.entries.filter((e) => e.action === 'auth.second_factor' && e.outcome === 'failure')
    expect(failures.length).toBeGreaterThanOrEqual(5)
    expect(JSON.stringify(stack.audit.entries)).not.toContain(secret)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run (server): `npx vitest run apps/core/test/step-up.test.ts`
Expected: FAIL, `../src/access/step-up.ts` does not exist.

- [ ] **Step 3: Write the check**

`apps/core/src/access/step-up.ts`:

```ts
import { APIError } from 'better-auth/api'
import { fromNodeHeaders } from 'better-auth/node'
import type { Request } from 'express'
import type { Auth } from '../auth/options.ts'
import { AppError } from '../errors.ts'

// "The second factor is asked again before changing roles, using the kill switch or exporting data."
// The code is the signed-in person's own current authenticator code, checked by the sign-in library's own
// TOTP check. That check runs the same hooks as a sign-in: the per-account lockout and the audit entry apply
// here too, so a stolen session cannot be used to guess codes without limit.
export async function verifySecondFactorCode(auth: Auth, req: Request, code: string): Promise<void> {
  try {
    await auth.api.verifyTOTP({ body: { code }, headers: fromNodeHeaders(req.headers) })
  } catch (error) {
    if (error instanceof APIError) {
      if (error.statusCode === 429) {
        throw new AppError(429, 'too_many_attempts', 'Too many attempts. Try again later.')
      }
      throw new AppError(403, 'second_factor_invalid', 'The code is not right.')
    }
    throw error
  }
}
```

If the pinned library's `verifyTOTP` for a signed-in person behaves differently from what the test expects (for example it answers 200 to a wrong code, or it starts a new session), stop and report it: this check is what stands between a stolen session and a role change. Do not weaken the test. If the library rejects a person whose second factor is already enabled, read its source on the server (`node_modules/better-auth/dist/plugins/two-factor/totp/index.mjs` and `verify-two-factor.mjs`) and record a ruling with what you found.

- [ ] **Step 4: Run to verify it passes**

Run (server): `npx vitest run apps/core`
Expected: PASS.

- [ ] **Step 5: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps/core
git commit -m "feat(access): ask for the actor's own authenticator code before a sensitive action"
```

---

### Task 5: Brands, and the generic cross-brand test (acceptance test 1)

**Files:**

- Create: `apps/core/src/routes/brands.ts`
- Modify: `apps/core/src/api.ts`
- Test: `apps/core/test/brands.test.ts`, `apps/core/test/cross-brand.test.ts`

**Interfaces:**

- Consumes: `RouteTable`, `brandContextOf`, `principalOf`, `withBrand`
- Produces:
  - `registerBrandRoutes(table: RouteTable, deps: { pool: Pool }): void`
  - `GET /api/v1/brands` (`enrolled`): `{ brands: { id, name, slug, status, role }[] }`, the brands the person has a membership in, and nothing else
  - `GET /api/v1/brands/:brandId` (`member`): `{ id, name, slug, status, shadowMode, role }` where `role` is the person's actor in that brand (`platform_owner` for the owner)
  - `cross-brand.test.ts`: for every route in the table whose path contains `:brandId`, a person in brand A gets 404 when the path names brand B, with no body, no brand ID and no other detail leaked. It applies itself to every route added later.

- [ ] **Step 1: Write the failing tests**

`apps/core/test/brands.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBrand, addUser, createStack, enrolledClient, signedInClient, type Stack } from './support.ts'

const PASSWORD = 'correct horse battery'

describe('brands', () => {
  let stack: Stack
  let brandA: string
  let brandB: string

  beforeAll(async () => {
    stack = await createStack()
    brandA = await addBrand(stack, 'brand-a')
    brandB = await addBrand(stack, 'brand-b')
    await addUser(stack, { email: 'viewer@example.test', password: PASSWORD, role: 'viewer', brandId: brandA })
    await addUser(stack, { email: 'both@example.test', password: PASSWORD, role: 'viewer', brandId: brandA })
    await stack.db.admin.query(
      "insert into app.membership (brand_id, user_id, role) select $1, id, 'viewer' from auth.\"user\" where email = 'both@example.test'",
      [brandB],
    )
    await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
  })
  afterAll(async () => stack?.close())

  it('lists only the brands the person belongs to, with their role in each', async () => {
    const viewer = await signedInClient(stack, 'viewer@example.test', PASSWORD)
    const own = await viewer.request('GET', '/api/v1/brands')
    expect(own.status).toBe(200)
    expect(own.json.brands).toEqual([{ id: brandA, name: 'brand-a', slug: 'brand-a', status: 'onboarding', role: 'viewer' }])
    const both = await signedInClient(stack, 'both@example.test', PASSWORD)
    const ids = (await both.request('GET', '/api/v1/brands')).json.brands.map((b: { id: string }) => b.id).sort()
    expect(ids).toEqual([brandA, brandB].sort())
  })

  it('reads one brand for a member, with their role, and refuses a stranger with a 404', async () => {
    const viewer = await signedInClient(stack, 'viewer@example.test', PASSWORD)
    const read = await viewer.request('GET', `/api/v1/brands/${brandA}`)
    expect(read.status).toBe(200)
    expect(read.json).toEqual({
      id: brandA,
      name: 'brand-a',
      slug: 'brand-a',
      status: 'onboarding',
      shadowMode: false,
      role: 'viewer',
    })
    expect((await viewer.request('GET', `/api/v1/brands/${brandB}`)).status).toBe(404)
  })

  it('lets the platform owner read any brand, as platform_owner, and lists no brand it has no membership in', async () => {
    const { client } = await enrolledClient(stack, 'owner@example.test', PASSWORD)
    const read = await client.request('GET', `/api/v1/brands/${brandB}`)
    expect(read.status).toBe(200)
    expect(read.json.role).toBe('platform_owner')
    expect((await client.request('GET', '/api/v1/brands')).json.brands).toEqual([])
  })

  it('needs a session', async () => {
    expect((await stack.newClient().request('GET', '/api/v1/brands')).status).toBe(401)
    expect((await stack.newClient().request('GET', `/api/v1/brands/${brandA}`)).status).toBe(401)
  })
})
```

`apps/core/test/cross-brand.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
const SOME_USER = '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b'

// Acceptance test 1: with a session for brand A, every operation refuses or returns nothing for brand B's
// records. It reads the route table, so a route added later is covered without anyone remembering to add it.
describe('no route under /brands/:brandId answers for a brand the person is not in', () => {
  let stack: Stack
  let brandA: string
  let brandB: string
  let admin: TestClient

  beforeAll(async () => {
    stack = await createStack()
    brandA = await addBrand(stack, 'brand-a')
    brandB = await addBrand(stack, 'brand-b')
    await addUser(stack, { email: 'admin@example.test', password: PASSWORD, role: 'brand_admin', brandId: brandA })
    admin = (await enrolledClient(stack, 'admin@example.test', PASSWORD)).client
  })
  afterAll(async () => stack?.close())

  const fill = (path: string, brand: string) =>
    path.replace(':brandId', brand).replace(/:[a-zA-Z]+/g, SOME_USER)

  it('finds the brand-scoped routes, so the checks below cannot pass on an empty list', () => {
    const scoped = stack.core.routes.list().filter((r) => r.path.includes(':brandId'))
    expect(scoped.length).toBeGreaterThanOrEqual(2)
  })

  it('answers 404 to a member of brand A for every route when the path names brand B', async () => {
    for (const route of stack.core.routes.list().filter((r) => r.path.includes(':brandId'))) {
      const reply = await admin.request(route.method.toUpperCase(), `/api/v1${fill(route.path, brandB)}`, { body: route.method === 'get' ? undefined : {} })
      expect(reply.status, `${route.method} ${route.path}`).toBe(404)
      expect(reply.text).not.toContain(brandB)
      expect(reply.json.error.code).toBe('not_found')
    }
  })

  it('does not answer 404 for the same routes in the person’s own brand', async () => {
    for (const route of stack.core.routes.list().filter((r) => r.path.includes(':brandId'))) {
      const reply = await admin.request(route.method.toUpperCase(), `/api/v1${fill(route.path, brandA)}`, { body: route.method === 'get' ? undefined : {} })
      expect([401, 404], `${route.method} ${route.path}`).not.toContain(reply.status)
    }
  })

  it('answers 401 with no session and 403 enrolment_required to someone not yet enrolled, for every such route', async () => {
    await addUser(stack, { email: 'new@example.test', password: PASSWORD, role: 'approver', brandId: brandA })
    const fresh = stack.newClient()
    await fresh.signIn('new@example.test', PASSWORD)
    for (const route of stack.core.routes.list().filter((r) => r.path.includes(':brandId'))) {
      const path = `/api/v1${fill(route.path, brandA)}`
      const none = await stack.newClient().request(route.method.toUpperCase(), path, { body: route.method === 'get' ? undefined : {}, origin: 'https://app.example.test' })
      expect([401, 403], `${route.method} ${route.path}`).toContain(none.status)
      const blocked = await fresh.request(route.method.toUpperCase(), path, { body: route.method === 'get' ? undefined : {} })
      expect(blocked.status, `${route.method} ${route.path}`).toBe(403)
      expect(blocked.json.error.code).toBe('enrolment_required')
    }
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run (server): `npx vitest run apps/core/test/brands.test.ts apps/core/test/cross-brand.test.ts`
Expected: FAIL, `/api/v1/brands` answers 401 or 404 for everyone because the routes do not exist yet; the cross-brand test finds fewer than 2 scoped routes.

- [ ] **Step 3: Write the brand routes**

`apps/core/src/routes/brands.ts`:

```ts
import { withBrand, type Pool } from '@mkt/db'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { principalOf } from '../auth/session.ts'
import { AppError } from '../errors.ts'
import { validate } from '../validate.ts'

interface BrandRow {
  id: string
  name: string
  slug: string
  status: string
  shadowMode: boolean
}

// Row-level security shows only the brand that was set, so this can never return another brand's row.
async function readBrand(pool: Pool, brandId: string): Promise<BrandRow | null> {
  return withBrand(pool, brandId, async (client) => {
    const result = await client.query('select id, name, slug, status, shadow_mode from app.brand')
    const row = result.rows[0]
    return row
      ? { id: row.id, name: row.name, slug: row.slug, status: row.status, shadowMode: row.shadow_mode }
      : null
  })
}

export function registerBrandRoutes(table: RouteTable, deps: { pool: Pool }): void {
  table.add({
    method: 'get',
    path: '/brands',
    access: { kind: 'enrolled' },
    summary: 'The brands the signed-in person belongs to',
    handlers: [
      async (_req, res) => {
        const brands = []
        for (const membership of principalOf(res).memberships) {
          const row = await readBrand(deps.pool, membership.brandId)
          if (row) brands.push({ id: row.id, name: row.name, slug: row.slug, status: row.status, role: membership.role })
        }
        res.json({ brands })
      },
    ],
  })

  table.add({
    method: 'get',
    path: '/brands/:brandId',
    access: { kind: 'member' },
    summary: 'One brand, with the signed-in person’s role in it',
    handlers: [
      validate({ params: z.strictObject({ brandId: z.uuid() }) }),
      async (_req, res) => {
        const context = brandContextOf(res)
        const row = await readBrand(deps.pool, context.brandId)
        if (!row) throw new AppError(404, 'not_found', 'There is nothing at this address.')
        res.json({ ...row, role: context.actor })
      },
    ],
  })
}
```

In `apps/core/src/api.ts` import `registerBrandRoutes` and call `registerBrandRoutes(table, { pool: deps.pool })` after `registerInviteRoutes(...)`.

- [ ] **Step 4: Run to verify they pass, then the whole suite**

Run (server): `npx vitest run apps/core`
Expected: PASS. In `brands.test.ts` the owner's `GET /brands` returns `[]` because the owner has no membership; that is the ruled behaviour (see Scope).

- [ ] **Step 5: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps/core
git commit -m "feat(brands): the person's own brands and one brand, with a test that no brand route answers for a stranger"
```

---

### Task 6: Users: list people and pending invites, and invite

**Files:**

- Create: `apps/core/src/users/service.ts`, `apps/core/src/routes/users.ts`
- Modify: `apps/core/src/auth/invites.ts`, `apps/core/src/api.ts`, `apps/core/src/core.ts`, `apps/core/test/support.ts`
- Test: `apps/core/test/users-list-invite.test.ts`

**Interfaces:**

- Consumes: `RouteTable`, `brandContextOf`, `principalOf`, `createInvite`, `emailHash` (from `auth/options.ts`), `AuditSink`, `Mailer`, `validate`, `inputOf`
- Produces:
  - `listMembers(pool, brandId): Promise<{ members: { userId; email; name; role; twoFactorEnabled; since }[]; pendingInvites: { id; email; role; expiresAt; expired }[] }>`: no token hash, no password hash, nothing from another brand
  - `createInvite` gains two optional inputs: `inside?: (client: PoolClient, invite: { id: string }) => Promise<void>` (run in the same transaction after the insert, so an audit entry that cannot be written rolls the invite back) and `onMailFailure?: (error: unknown) => void`. If the mail cannot be sent, the invite row is deleted and it throws `AppError(502, 'mail_not_sent', …)`.
  - `GET /api/v1/brands/:brandId/users` (`permission: manage_users`) returns `{ members, pendingInvites }`
  - `POST /api/v1/brands/:brandId/users/invites` (`permission: manage_users`), body `{ email, role }` (`role` one of `brand_admin`, `approver`, `sales_contact`, `viewer`), returns 201 `{ id, expiresAt }` and never the token; audits `users.invited` with `brandId`, the actor, `detail { role, emailHash, inviteId }`
  - `ApiDeps` gains `mailer: Mailer`, `origin: string` and `onMailFailure?: (error: unknown) => void`; `buildCore` passes `deps.mailer`, `config.publicOrigin` and the same reporter it gives the library (`logger.error({ err }, 'mail not sent')`)

- [ ] **Step 1: Write the failing test**

`apps/core/test/users-list-invite.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryMailer, ThrowingMailer } from '../src/testing.ts'
import { ORIGIN, addBrand, addUser, createStack, enrolledClient, signedInClient, tokenFromMail, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'

describe('listing people and inviting (users routes, part 1)', () => {
  let stack: Stack
  let brandA: string
  let brandB: string
  let admin: TestClient
  let approver: TestClient
  let owner: TestClient

  const invite = (client: TestClient, brand: string, body: unknown) =>
    client.request('POST', `/api/v1/brands/${brand}/users/invites`, { body })

  beforeAll(async () => {
    stack = await createStack()
    brandA = await addBrand(stack, 'brand-a')
    brandB = await addBrand(stack, 'brand-b')
    await addUser(stack, { email: 'admin@example.test', password: PASSWORD, role: 'brand_admin', brandId: brandA })
    await addUser(stack, { email: 'approver@example.test', password: PASSWORD, role: 'approver', brandId: brandA })
    await addUser(stack, { email: 'b-admin@example.test', password: PASSWORD, role: 'brand_admin', brandId: brandB })
    await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
    admin = (await enrolledClient(stack, 'admin@example.test', PASSWORD)).client
    approver = (await enrolledClient(stack, 'approver@example.test', PASSWORD)).client
    owner = (await enrolledClient(stack, 'owner@example.test', PASSWORD)).client
  })
  afterAll(async () => stack?.close())

  it('lists the people of the brand and nobody else, with no secret in the answer', async () => {
    const reply = await admin.request('GET', `/api/v1/brands/${brandA}/users`)
    expect(reply.status).toBe(200)
    expect(reply.json.members.map((m: { email: string }) => m.email).sort()).toEqual([
      'admin@example.test',
      'approver@example.test',
    ])
    const admins = reply.json.members.find((m: { email: string }) => m.email === 'admin@example.test')
    expect(admins).toMatchObject({ role: 'brand_admin', twoFactorEnabled: true, name: 'admin' })
    expect(reply.text).not.toMatch(/token|hash|password/i)
    expect(reply.text).not.toContain('b-admin@example.test')
  })

  it('is for brand admins and the platform owner only', async () => {
    expect((await approver.request('GET', `/api/v1/brands/${brandA}/users`)).status).toBe(403)
    expect((await owner.request('GET', `/api/v1/brands/${brandA}/users`)).status).toBe(200)
    expect((await admin.request('GET', `/api/v1/brands/${brandB}/users`)).status).toBe(404)
  })

  it('invites a person: 201, no token in the answer, the link goes to the person, and it is audited', async () => {
    const before = stack.mailer.sent.length
    const reply = await invite(admin, brandA, { email: 'New.Person@Example.test', role: 'approver' })
    expect(reply.status).toBe(201)
    expect(Object.keys(reply.json).sort()).toEqual(['expiresAt', 'id'])
    const mail = stack.mailer.sent[before]!
    expect(mail.to).toBe('new.person@example.test')
    expect(mail.text).toContain(`${ORIGIN}/accept-invite?token=`)
    expect(reply.text).not.toContain(tokenFromMail(mail))
    const entry = stack.audit.entries.filter((e) => e.action === 'users.invited').at(-1)!
    expect(entry).toMatchObject({ outcome: 'success', brandId: brandA, detail: { role: 'approver', inviteId: reply.json.id } })
    expect(JSON.stringify(entry)).not.toContain('example.test')
  })

  it('shows the invite as pending with its expiry, and the invited person can then accept it', async () => {
    const list = await admin.request('GET', `/api/v1/brands/${brandA}/users`)
    const pending = list.json.pendingInvites.find((i: { email: string }) => i.email === 'new.person@example.test')
    expect(pending).toMatchObject({ role: 'approver', expired: false })
    expect(new Date(pending.expiresAt).getTime()).toBeGreaterThan(Date.now())
    const token = tokenFromMail(stack.mailer.sent.at(-1)!)
    const accept = await stack.newClient().request('POST', '/api/v1/invites/accept', {
      body: { token, name: 'New Person', password: PASSWORD },
    })
    expect(accept.status).toBe(201)
    const after = await admin.request('GET', `/api/v1/brands/${brandA}/users`)
    expect(after.json.pendingInvites).toEqual([])
    expect(after.json.members.map((m: { email: string }) => m.email)).toContain('new.person@example.test')
  })

  it('lets only people who manage users invite, only into their own brand, and never as a platform owner', async () => {
    expect((await invite(approver, brandA, { email: 'x@example.test', role: 'viewer' })).status).toBe(403)
    expect((await invite(admin, brandB, { email: 'x@example.test', role: 'viewer' })).status).toBe(404)
    expect((await invite(admin, brandA, { email: 'x@example.test', role: 'platform_owner' })).status).toBe(400)
    expect((await invite(owner, brandB, { email: 'from-owner@example.test', role: 'viewer' })).status).toBe(201)
  })

  it('refuses a bad email, an unknown field, and a missing role before anything is written', async () => {
    const count = async () => (await stack.db.admin.query('select count(*)::int as n from app.invite')).rows[0].n
    const before = await count()
    expect((await invite(admin, brandA, { email: 'not-an-email', role: 'viewer' })).status).toBe(400)
    expect((await invite(admin, brandA, { email: 'a@example.test', role: 'viewer', brandId: brandB })).status).toBe(400)
    expect((await invite(admin, brandA, { email: 'a@example.test' })).status).toBe(400)
    expect(await count()).toBe(before)
  })

  it('uses the configured origin for the link, whatever the request says about its host', async () => {
    const before = stack.mailer.sent.length
    await admin.request('POST', `/api/v1/brands/${brandA}/users/invites`, {
      body: { email: 'host@example.test', role: 'viewer' },
      headers: { 'x-forwarded-host': 'evil.example.test', host: 'evil.example.test' },
    })
    expect(stack.mailer.sent[before]!.text).toContain(`${ORIGIN}/accept-invite?token=`)
    expect(stack.mailer.sent[before]!.text).not.toContain('evil.example.test')
  })
})

describe('inviting when mail cannot be sent, or the audit cannot be written', () => {
  it('answers 502 and leaves no invite behind when the mail fails, and reports it', async () => {
    const mailer = new ThrowingMailer()
    const stack = await createStack({ mailer })
    try {
      const brand = await addBrand(stack, 'brand-m')
      await addUser(stack, { email: 'admin@example.test', password: PASSWORD, role: 'brand_admin', brandId: brand })
      const { client } = await enrolledClient(stack, 'admin@example.test', PASSWORD)
      const reply = await client.request('POST', `/api/v1/brands/${brand}/users/invites`, {
        body: { email: 'x@example.test', role: 'viewer' },
      })
      expect(reply.status).toBe(502)
      expect(reply.json.error.code).toBe('mail_not_sent')
      expect((await stack.db.admin.query('select count(*)::int as n from app.invite')).rows[0].n).toBe(0)
      expect(stack.logs.join('')).toContain('mail not sent')
      expect(stack.logs.join('')).not.toContain('x@example.test')
    } finally {
      await stack.close()
    }
  })

  it('rolls the invite back, and sends no mail, when the audit entry cannot be written (fail-closed)', async () => {
    class FailingAudit extends (await import('../src/testing.ts')).MemoryAudit {
      override async record(entry: Parameters<InstanceType<typeof MemoryAudit>['record']>[0]): Promise<void> {
        if (entry.action === 'users.invited') throw new Error('audit is down')
        await super.record(entry)
      }
    }
    const mailer = new MemoryMailer()
    const stack = await createStack({ mailer, audit: new FailingAudit() })
    try {
      const brand = await addBrand(stack, 'brand-f')
      await addUser(stack, { email: 'admin@example.test', password: PASSWORD, role: 'brand_admin', brandId: brand })
      const { client } = await enrolledClient(stack, 'admin@example.test', PASSWORD)
      const before = mailer.sent.length
      const reply = await client.request('POST', `/api/v1/brands/${brand}/users/invites`, {
        body: { email: 'x@example.test', role: 'viewer' },
      })
      expect(reply.status).toBe(500)
      expect((await stack.db.admin.query('select count(*)::int as n from app.invite')).rows[0].n).toBe(0)
      expect(mailer.sent.length).toBe(before)
    } finally {
      await stack.close()
    }
  })
})
```

Add `import { MemoryAudit } from '../src/testing.ts'` to the top of the file's imports in place of the inline dynamic import (the inline form above only shows where `MemoryAudit` comes from); keep one import block.

- [ ] **Step 2: Run to verify it fails**

Run (server): `npx vitest run apps/core/test/users-list-invite.test.ts`
Expected: FAIL, the users routes answer 404 and `createInvite` has no `inside` input.

- [ ] **Step 3: Change `createInvite`**

In `apps/core/src/auth/invites.ts`, replace `createInvite` with:

```ts
export async function createInvite(
  pool: Pool,
  mailer: Mailer,
  input: {
    brandId: string
    email: string
    role: Role
    invitedBy: string
    origin: string
    // Runs inside the same transaction, after the insert. If it throws (for example the audit entry cannot
    // be written) the invite is rolled back and no mail is sent.
    inside?: (client: PoolClient, invite: { id: string }) => Promise<void>
    onMailFailure?: (error: unknown) => void
  },
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
    const created = result.rows[0] as { id: string; expires_at: Date }
    await input.inside?.(client, { id: created.id })
    return created
  })
  try {
    await mailer.send({
      to: email,
      subject: 'You have been invited',
      text: `You have been invited. Open this link to set a password:\n${input.origin}/accept-invite?token=${token}\nThe link works once and expires in ${INVITE_HOURS} hours.`,
    })
  } catch (error) {
    // An invite nobody was told about is worse than none: take it back, and tell the person who asked.
    await withBrand(pool, input.brandId, (client) => client.query('delete from app.invite where id = $1', [row.id]))
    input.onMailFailure?.(error)
    throw new AppError(502, 'mail_not_sent', 'The invite email could not be sent, so no invite was made.')
  }
  return { id: row.id, expiresAt: row.expires_at }
}
```

(import `type PoolClient` from `@mkt/db` alongside `withBrand` and `type Pool`.)

- [ ] **Step 4: Write the list service and the routes**

`apps/core/src/users/service.ts`:

```ts
import { withBrand, type Pool } from '@mkt/db'
import type { Role } from '../auth/session.ts'

export interface Member {
  userId: string
  email: string
  name: string
  role: Role
  twoFactorEnabled: boolean
  since: string
}

export interface PendingInvite {
  id: string
  email: string
  role: Role
  expiresAt: string
  expired: boolean
}

// Row-level security limits the membership and invite rows to the brand set for the transaction. The user's
// own columns come from the sign-in library's table; no hash and no token column is ever selected.
export async function listMembers(
  pool: Pool,
  brandId: string,
): Promise<{ members: Member[]; pendingInvites: PendingInvite[] }> {
  return withBrand(pool, brandId, async (client) => {
    const members = await client.query(
      `select m.user_id, u.email, u.name, m.role, u."twoFactorEnabled" as two_factor_enabled, m.created_at
         from app.membership m join auth."user" u on u.id = m.user_id
        order by u.email`,
    )
    const invites = await client.query(
      `select id, email, role, expires_at, expires_at <= now() as expired
         from app.invite where used_at is null order by created_at`,
    )
    return {
      members: members.rows.map((row) => ({
        userId: row.user_id,
        email: row.email,
        name: row.name,
        role: row.role,
        twoFactorEnabled: Boolean(row.two_factor_enabled),
        since: new Date(row.created_at).toISOString(),
      })),
      pendingInvites: invites.rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        expiresAt: new Date(row.expires_at).toISOString(),
        expired: Boolean(row.expired),
      })),
    }
  })
}
```

`apps/core/src/routes/users.ts`:

```ts
import type { Pool } from '@mkt/db'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { createInvite } from '../auth/invites.ts'
import { emailHash } from '../auth/options.ts'
import { principalOf } from '../auth/session.ts'
import type { AuditSink, Mailer } from '../ports.ts'
import { listMembers } from '../users/service.ts'
import { inputOf, validate } from '../validate.ts'

export const ROLES = ['brand_admin', 'approver', 'sales_contact', 'viewer'] as const

const brandParams = z.strictObject({ brandId: z.uuid() })
const inviteBody = z.strictObject({ email: z.email().max(254), role: z.enum(ROLES) })

export interface UserRouteDeps {
  pool: Pool
  mailer: Mailer
  audit: AuditSink
  origin: string
  onMailFailure?: (error: unknown) => void
}

export function registerUserRoutes(table: RouteTable, deps: UserRouteDeps): void {
  table.add({
    method: 'get',
    path: '/brands/:brandId/users',
    access: { kind: 'permission', permission: 'manage_users' },
    summary: 'The people of a brand, and its pending invites',
    handlers: [
      validate({ params: brandParams }),
      async (_req, res) => {
        res.json(await listMembers(deps.pool, brandContextOf(res).brandId))
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/users/invites',
    access: { kind: 'permission', permission: 'manage_users' },
    summary: 'Invite a person into a brand with a role',
    handlers: [
      validate({ params: brandParams, body: inviteBody }),
      async (_req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof inviteBody> }>(res)
        const brand = brandContextOf(res)
        const actor = principalOf(res).userId
        const invite = await createInvite(deps.pool, deps.mailer, {
          brandId: brand.brandId,
          email: body.email,
          role: body.role,
          invitedBy: actor,
          origin: deps.origin,
          onMailFailure: deps.onMailFailure,
          // In the invite's own transaction: if the audit entry cannot be written, there is no invite.
          inside: (_client, created) =>
            deps.audit.record({
              action: 'users.invited',
              actor,
              brandId: brand.brandId,
              outcome: 'success',
              detail: { role: body.role, emailHash: emailHash(body.email), inviteId: created.id },
            }),
        })
        res.status(201).json({ id: invite.id, expiresAt: invite.expiresAt })
      },
    ],
  })
}
```

In `apps/core/src/api.ts`: add `mailer: Mailer`, `origin: string` and `onMailFailure?: (error: unknown) => void` to `ApiDeps`, import `registerUserRoutes`, and after `registerBrandRoutes(...)` add:

```ts
  registerUserRoutes(table, {
    pool: deps.pool,
    mailer: deps.mailer,
    audit: deps.audit,
    origin: deps.origin,
    onMailFailure: deps.onMailFailure,
  })
```

In `apps/core/src/core.ts`, give `createApi` the three new fields: `mailer: deps.mailer`, `origin: config.publicOrigin`, and `onMailFailure: (error) => deps.logger.error({ err: error }, 'mail not sent')`.

`ThrowingMailer` and `MemoryAudit` already exist in `apps/core/src/testing.ts` (milestone 2b); `Stack.logs` already collects the service's log lines.

- [ ] **Step 5: Run to verify it passes**

Run (server): `npx vitest run apps/core`
Expected: PASS, including `cross-brand.test.ts`, which now finds the two users routes as well and must still answer 404 for brand B.

- [ ] **Step 6: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps/core
git commit -m "feat(users): list a brand's people and pending invites, and invite, audited in the invite's own transaction"
```

---

### Task 7: Users: change a role and remove a person

**Files:**

- Modify: `apps/core/src/users/service.ts`, `apps/core/src/routes/users.ts`, `apps/core/src/api.ts`
- Test: `apps/core/test/users-role-remove.test.ts`

**Interfaces:**

- Consumes: `verifySecondFactorCode` (Task 4), `brandContextOf`, `principalOf`, `withBrand`, `AuditSink`, `AppError`
- Produces:
  - `changeMemberRole(pool, audit, input: { brandId; actorId; actorIsPlatformOwner; targetId; role }): Promise<{ userId: string; role: Role; changed: boolean }>`
  - `removeMember(pool, audit, input: { brandId; actorId; actorIsPlatformOwner; targetId }): Promise<void>`
  - `PATCH /api/v1/brands/:brandId/users/:userId` (`permission: manage_users`), body `{ role, code }`, returns 200 `{ userId, role }`; audits `users.role_changed` with `detail { from, to }`
  - `DELETE /api/v1/brands/:brandId/users/:userId` (`permission: manage_users`), body `{ code }`, returns 204; audits `users.removed` with `detail { role }`
  - Rules, all answered before anything changes: the actor's own `code` is checked first (403 `second_factor_invalid`); the target must be a member (404); nobody changes or removes themselves (409 `cannot_change_own_membership`); only the platform owner may touch a platform owner's membership (403 `forbidden`); the last brand admin cannot be demoted or removed (409 `last_admin`); an unchanged role answers 200 with `changed: false` and writes no audit entry. The change and its audit entry are in one transaction: if the audit cannot be written, nothing changes.
  - Removing a person deletes the membership; if they have no membership left in any brand and are not the platform owner, their sessions end (`auth.session` rows deleted in the same transaction).

- [ ] **Step 1: Write the failing test**

`apps/core/test/users-role-remove.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryAudit } from '../src/testing.ts'
import { addBrand, addUser, createStack, enrolledClient, signedInClient, totp, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
type AuditEntry = Parameters<MemoryAudit['record']>[0]

class FailingAudit extends MemoryAudit {
  failOn: string | null = null
  override async record(entry: AuditEntry): Promise<void> {
    if (entry.action === this.failOn) throw new Error('audit is down')
    await super.record(entry)
  }
}

describe('changing a role and removing a person (users routes, part 2)', () => {
  let stack: Stack
  let audit: FailingAudit
  let brand: string
  let other: string
  const people = new Map<string, { id: string; client: TestClient; secret: string }>()

  const patch = (who: string, target: string, body: Record<string, unknown>) =>
    people.get(who)!.client.request('PATCH', `/api/v1/brands/${brand}/users/${target}`, { body })
  const remove = (who: string, target: string, body: Record<string, unknown>) =>
    people.get(who)!.client.request('DELETE', `/api/v1/brands/${brand}/users/${target}`, { body })
  const code = (who: string) => totp(people.get(who)!.secret)
  const roleOf = async (userId: string) =>
    (await stack.db.admin.query('select role from app.membership where brand_id = $1 and user_id = $2', [brand, userId])).rows[0]?.role

  async function person(key: string, role: 'brand_admin' | 'approver' | 'viewer', brandId = brand) {
    const email = `${key}@example.test`
    const id = await addUser(stack, { email, password: PASSWORD, role, brandId })
    const { client, secret } = role === 'viewer'
      ? { client: await signedInClient(stack, email, PASSWORD), secret: '' }
      : await enrolledClient(stack, email, PASSWORD)
    people.set(key, { id, client, secret })
  }

  beforeAll(async () => {
    audit = new FailingAudit()
    stack = await createStack({ audit })
    brand = await addBrand(stack, 'brand-a')
    other = await addBrand(stack, 'brand-b')
    await person('admin', 'brand_admin')
    await person('admin2', 'brand_admin')
    await person('approver', 'approver')
    await person('viewer', 'viewer')
    const ownerId = await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
    const owner = await enrolledClient(stack, 'owner@example.test', PASSWORD)
    people.set('owner', { id: ownerId, client: owner.client, secret: owner.secret })
  })
  afterAll(async () => stack?.close())

  it('changes a role with the actor’s own code, writes one audit entry, and takes effect on the next request', async () => {
    const target = people.get('approver')!
    const reply = await patch('admin', target.id, { role: 'viewer', code: code('admin') })
    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({ userId: target.id, role: 'viewer' })
    expect(await roleOf(target.id)).toBe('viewer')
    const entry = audit.entries.filter((e) => e.action === 'users.role_changed').at(-1)!
    expect(entry).toMatchObject({ actor: people.get('admin')!.id, subject: target.id, brandId: brand, detail: { from: 'approver', to: 'viewer' } })
    // The person's powers changed at once: the permission is read per request, not kept in the session.
    expect((await target.client.request('GET', `/api/v1/brands/${brand}/users`)).status).toBe(403)
    await patch('admin', target.id, { role: 'approver', code: code('admin') })
  })

  it('refuses a missing code (400), a wrong code (403) and another person’s code (403), and changes nothing', async () => {
    const target = people.get('approver')!
    expect((await patch('admin', target.id, { role: 'viewer' })).status).toBe(400)
    expect((await patch('admin', target.id, { role: 'viewer', code: '000000' })).status).toBe(403)
    expect((await patch('admin', target.id, { role: 'viewer', code: code('admin2') })).status).toBe(403)
    expect(await roleOf(target.id)).toBe('approver')
  })

  it('counts wrong codes against the actor’s lockout (five locks the account, even for the right code)', async () => {
    const locked = people.get('admin2')!
    for (let i = 0; i < 5; i++) {
      expect((await patch('admin2', people.get('viewer')!.id, { role: 'approver', code: '000000' })).status).toBe(403)
    }
    expect((await patch('admin2', people.get('viewer')!.id, { role: 'approver', code: totp(locked.secret) })).status).toBe(429)
    stack.limiter.succeed(`/two-factor:${locked.id}`)
  })

  it('refuses to let anyone change or remove their own membership', async () => {
    const me = people.get('admin')!
    const change = await patch('admin', me.id, { role: 'viewer', code: code('admin') })
    expect(change.status).toBe(409)
    expect(change.json.error.code).toBe('cannot_change_own_membership')
    expect((await remove('admin', me.id, { code: code('admin') })).status).toBe(409)
    expect(await roleOf(me.id)).toBe('brand_admin')
  })

  it('answers 404 for someone who is not a member of the brand, and for a brand the actor is not in', async () => {
    const stranger = await addUser(stack, { email: 'elsewhere@example.test', password: PASSWORD, role: 'viewer', brandId: other })
    expect((await patch('admin', stranger, { role: 'viewer', code: code('admin') })).status).toBe(404)
    const otherBrand = await people.get('admin')!.client.request('PATCH', `/api/v1/brands/${other}/users/${stranger}`, {
      body: { role: 'approver', code: code('admin') },
    })
    expect(otherBrand.status).toBe(404)
  })

  it('refuses a role that is not one of the four, and an unknown field', async () => {
    const target = people.get('approver')!
    expect((await patch('admin', target.id, { role: 'platform_owner', code: code('admin') })).status).toBe(400)
    expect((await patch('admin', target.id, { role: 'viewer', code: code('admin'), brandId: other })).status).toBe(400)
  })

  it('refuses to demote or remove the last brand admin, and allows it once another exists', async () => {
    const solo = await addBrand(stack, 'brand-solo')
    const soloAdmin = await addUser(stack, { email: 'solo@example.test', password: PASSWORD, role: 'brand_admin', brandId: solo })
    const ownerClient = people.get('owner')!
    const url = `/api/v1/brands/${solo}/users/${soloAdmin}`
    const demote = await ownerClient.client.request('PATCH', url, { body: { role: 'viewer', code: totp(ownerClient.secret) } })
    expect(demote.status).toBe(409)
    expect(demote.json.error.code).toBe('last_admin')
    const removal = await ownerClient.client.request('DELETE', url, { body: { code: totp(ownerClient.secret) } })
    expect(removal.status).toBe(409)
    const second = await addUser(stack, { email: 'solo2@example.test', password: PASSWORD, role: 'brand_admin', brandId: solo })
    expect((await ownerClient.client.request('DELETE', url, { body: { code: totp(ownerClient.secret) } })).status).toBe(204)
    expect(second).toBeDefined()
  })

  it('never leaves a brand with no admin when two admins demote each other at the same moment', async () => {
    const pair = await addBrand(stack, 'brand-pair')
    const emailA = 'pair-a@example.test'
    const emailB = 'pair-b@example.test'
    const idA = await addUser(stack, { email: emailA, password: PASSWORD, role: 'brand_admin', brandId: pair })
    const idB = await addUser(stack, { email: emailB, password: PASSWORD, role: 'brand_admin', brandId: pair })
    const a = await enrolledClient(stack, emailA, PASSWORD)
    const b = await enrolledClient(stack, emailB, PASSWORD)
    const demote = (who: typeof a, target: string) =>
      who.client.request('PATCH', `/api/v1/brands/${pair}/users/${target}`, { body: { role: 'viewer', code: totp(who.secret) } })
    const replies = await Promise.all([demote(a, idB), demote(b, idA)])
    expect(replies.filter((r) => r.status === 200)).toHaveLength(1)
    const admins = await stack.db.admin.query("select count(*)::int as n from app.membership where brand_id = $1 and role = 'brand_admin'", [pair])
    expect(admins.rows[0].n).toBe(1)
  })

  it('lets only the platform owner touch a platform owner’s membership', async () => {
    const ownerInBrand = await addUser(stack, { email: 'owner-member@example.test', password: PASSWORD, role: 'approver', brandId: brand, platformOwner: true })
    const byAdmin = await patch('admin', ownerInBrand, { role: 'viewer', code: code('admin') })
    expect(byAdmin.status).toBe(403)
    expect(await roleOf(ownerInBrand)).toBe('approver')
    const owner = people.get('owner')!
    const byOwner = await owner.client.request('PATCH', `/api/v1/brands/${brand}/users/${ownerInBrand}`, { body: { role: 'viewer', code: totp(owner.secret) } })
    expect(byOwner.status).toBe(200)
  })

  it('removes a person: the membership goes, and their sessions end when none is left', async () => {
    const target = people.get('viewer')!
    expect((await target.client.request('GET', '/api/v1/session')).status).toBe(200)
    const reply = await remove('admin', target.id, { code: code('admin') })
    expect(reply.status).toBe(204)
    expect(await roleOf(target.id)).toBeUndefined()
    expect((await target.client.request('GET', '/api/v1/session')).status).toBe(401)
    const entry = audit.entries.filter((e) => e.action === 'users.removed').at(-1)!
    expect(entry).toMatchObject({ subject: target.id, brandId: brand, detail: { role: 'viewer' } })
    expect((await stack.db.admin.query('select 1 from auth."user" where id = $1', [target.id])).rowCount).toBe(1)
  })

  it('keeps a removed person’s sessions when they still belong to another brand', async () => {
    const both = await addUser(stack, { email: 'both@example.test', password: PASSWORD, role: 'viewer', brandId: brand })
    await stack.db.admin.query("insert into app.membership (brand_id, user_id, role) values ($1, $2, 'viewer')", [other, both])
    const client = await signedInClient(stack, 'both@example.test', PASSWORD)
    expect((await remove('admin', both, { code: code('admin') })).status).toBe(204)
    expect((await client.request('GET', '/api/v1/session')).status).toBe(200)
  })

  it('rolls the change back when the audit entry cannot be written (fail-closed)', async () => {
    const target = people.get('approver')!
    audit.failOn = 'users.role_changed'
    const reply = await patch('admin', target.id, { role: 'viewer', code: code('admin') })
    audit.failOn = null
    expect(reply.status).toBe(500)
    expect(await roleOf(target.id)).toBe('approver')
  })

  it('answers 200 with changed: false, and writes no audit entry, when the role is already that role', async () => {
    const target = people.get('approver')!
    const before = audit.entries.length
    const reply = await patch('admin', target.id, { role: 'approver', code: code('admin') })
    expect(reply.status).toBe(200)
    expect(audit.entries.filter((e) => e.action === 'users.role_changed').length).toBe(
      audit.entries.slice(0, before).filter((e) => e.action === 'users.role_changed').length,
    )
  })

  it('is for people who manage users: an approver gets 403 before any code is looked at', async () => {
    const reply = await patch('approver', people.get('admin2')!.id, { role: 'viewer', code: '000000' })
    expect(reply.status).toBe(403)
    expect(reply.json.error.code).toBe('forbidden')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run (server): `npx vitest run apps/core/test/users-role-remove.test.ts`
Expected: FAIL, the PATCH and DELETE routes answer 404.

- [ ] **Step 3: Add the service functions**

Append to `apps/core/src/users/service.ts` (add `import { AppError } from '../errors.ts'`, `import type { AuditSink } from '../ports.ts'`):

```ts
interface Actor {
  brandId: string
  actorId: string
  actorIsPlatformOwner: boolean
  targetId: string
}

// Everything below runs in one transaction with the brand set. The brand's membership rows are locked first,
// so two requests that would together leave the brand with no admin cannot both pass the check.
async function lockMembers(client: import('@mkt/db').PoolClient, brandId: string) {
  const result = await client.query(
    'select user_id, role from app.membership where brand_id = $1 for update',
    [brandId],
  )
  return result.rows as { user_id: string; role: Role }[]
}

async function guardTarget(
  client: import('@mkt/db').PoolClient,
  input: Actor,
  members: { user_id: string; role: Role }[],
) {
  const target = members.find((m) => m.user_id === input.targetId)
  if (!target) throw new AppError(404, 'not_found', 'There is nothing at this address.')
  if (input.targetId === input.actorId) {
    throw new AppError(409, 'cannot_change_own_membership', 'You cannot change or remove your own membership here.')
  }
  if (!input.actorIsPlatformOwner) {
    const owner = await client.query('select app.is_platform_owner($1) as owner', [input.targetId])
    if (owner.rows[0].owner) throw new AppError(403, 'forbidden', 'You do not have permission to do this.')
  }
  return target
}

function lastAdmin(members: { role: Role }[]): boolean {
  return members.filter((m) => m.role === 'brand_admin').length <= 1
}

export async function changeMemberRole(
  pool: Pool,
  audit: AuditSink,
  input: Actor & { role: Role },
): Promise<{ userId: string; role: Role; changed: boolean }> {
  return withBrand(pool, input.brandId, async (client) => {
    const members = await lockMembers(client, input.brandId)
    const target = await guardTarget(client, input, members)
    if (target.role === input.role) return { userId: input.targetId, role: input.role, changed: false }
    if (target.role === 'brand_admin' && lastAdmin(members)) {
      throw new AppError(409, 'last_admin', 'A brand needs at least one admin. Make someone else an admin first.')
    }
    await client.query('update app.membership set role = $1 where brand_id = $2 and user_id = $3', [
      input.role,
      input.brandId,
      input.targetId,
    ])
    // In the same transaction: if the entry cannot be written, the change is rolled back.
    await audit.record({
      action: 'users.role_changed',
      actor: input.actorId,
      subject: input.targetId,
      brandId: input.brandId,
      outcome: 'success',
      detail: { from: target.role, to: input.role },
    })
    return { userId: input.targetId, role: input.role, changed: true }
  })
}

export async function removeMember(pool: Pool, audit: AuditSink, input: Actor): Promise<void> {
  await withBrand(pool, input.brandId, async (client) => {
    const members = await lockMembers(client, input.brandId)
    const target = await guardTarget(client, input, members)
    if (target.role === 'brand_admin' && lastAdmin(members)) {
      throw new AppError(409, 'last_admin', 'A brand needs at least one admin. Make someone else an admin first.')
    }
    await client.query('delete from app.membership where brand_id = $1 and user_id = $2', [
      input.brandId,
      input.targetId,
    ])
    // Their account stays (other tables refer to it). With no membership left, and not the platform owner,
    // they have nothing to do here: end their sessions.
    const left = await client.query('select count(*)::int as n from app.memberships_for_user($1)', [input.targetId])
    const owner = await client.query('select app.is_platform_owner($1) as owner', [input.targetId])
    if (left.rows[0].n === 0 && !owner.rows[0].owner) {
      await client.query('delete from auth.session where "userId" = $1', [input.targetId])
    }
    await audit.record({
      action: 'users.removed',
      actor: input.actorId,
      subject: input.targetId,
      brandId: input.brandId,
      outcome: 'success',
      detail: { role: target.role },
    })
  })
}
```

Replace the two `import('@mkt/db').PoolClient` inline types with a proper `import { withBrand, type Pool, type PoolClient } from '@mkt/db'` at the top of the file.

- [ ] **Step 4: Add the routes**

In `apps/core/src/routes/users.ts` add `auth: Auth` to `UserRouteDeps` (import `type Auth` from `../auth/options.ts`), import `verifySecondFactorCode` from `../access/step-up.ts`, `changeMemberRole` and `removeMember` from `../users/service.ts`, and add:

```ts
const memberParams = z.strictObject({ brandId: z.uuid(), userId: z.uuid() })
const code = z.string().regex(/^\d{6}$/)
const roleBody = z.strictObject({ role: z.enum(ROLES), code })
const removeBody = z.strictObject({ code })
```

and inside `registerUserRoutes`:

```ts
  table.add({
    method: 'patch',
    path: '/brands/:brandId/users/:userId',
    access: { kind: 'permission', permission: 'manage_users' },
    summary: 'Change a person’s role in a brand (asks for the actor’s own code)',
    handlers: [
      validate({ params: memberParams, body: roleBody }),
      async (req, res) => {
        const { body, params } = inputOf<{ body: z.infer<typeof roleBody>; params: z.infer<typeof memberParams> }>(res)
        const actor = principalOf(res)
        await verifySecondFactorCode(deps.auth, req, body.code)
        const result = await changeMemberRole(deps.pool, deps.audit, {
          brandId: brandContextOf(res).brandId,
          actorId: actor.userId,
          actorIsPlatformOwner: actor.isPlatformOwner,
          targetId: params.userId,
          role: body.role,
        })
        res.json({ userId: result.userId, role: result.role })
      },
    ],
  })

  table.add({
    method: 'delete',
    path: '/brands/:brandId/users/:userId',
    access: { kind: 'permission', permission: 'manage_users' },
    summary: 'Remove a person from a brand (asks for the actor’s own code)',
    handlers: [
      validate({ params: memberParams, body: removeBody }),
      async (req, res) => {
        const { body, params } = inputOf<{ body: z.infer<typeof removeBody>; params: z.infer<typeof memberParams> }>(res)
        const actor = principalOf(res)
        await verifySecondFactorCode(deps.auth, req, body.code)
        await removeMember(deps.pool, deps.audit, {
          brandId: brandContextOf(res).brandId,
          actorId: actor.userId,
          actorIsPlatformOwner: actor.isPlatformOwner,
          targetId: params.userId,
        })
        res.status(204).end()
      },
    ],
  })
```

In `apps/core/src/api.ts` pass `auth: deps.auth` in the `registerUserRoutes` call.

- [ ] **Step 5: Run to verify it passes**

Run (server): `npx vitest run apps/core`
Expected: PASS. Two things to watch and report, not to paper over:

- If the concurrent-demotion test ever returns two 200s, the row lock is not serialising the two requests: stop and report it (Review Focus 3).
- If `for update` on `app.membership` is refused for `mkt_app`, check the `brand_isolation` policy and the grants from migration 0004 (the role has `update` on the table); do not widen a policy.

- [ ] **Step 6: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps/core
git commit -m "feat(users): change a role and remove a person, with the actor's own code, last-admin and self rules, and audit in the same transaction"
```

---

### Task 8: Users: reset a second factor (platform owner only)

**Files:**

- Modify: `apps/core/src/users/service.ts`, `apps/core/src/routes/users.ts`
- Test: `apps/core/test/users-reset-second-factor.test.ts`

**Interfaces:**

- Consumes: `verifySecondFactorCode`, `AuditSink`, `Mailer`, `RouteTable` (kind `platform_owner`)
- Produces:
  - `resetSecondFactor(pool, audit, input: { actorId: string; targetId: string }): Promise<{ email: string }>`: in one transaction it deletes the person's `auth."twoFactor"` row (their secret and backup codes), sets `auth."user"."twoFactorEnabled"` to false, deletes their `auth.session` rows, and records `users.second_factor_reset` (`actor`, `subject`, `brandId: null`). A missing person is 404, resetting yourself is 409 `cannot_reset_own_second_factor` (the owner's own reset is the documented server-side procedure, spec section 7).
  - `POST /api/v1/users/:userId/second-factor/reset` (`platform_owner`), body `{ code }` (the owner's own code), returns 204; after commit the person is told by email that their second factor was reset (fail-open, reported through `onMailFailure`).

- [ ] **Step 1: Write the failing test**

`apps/core/test/users-reset-second-factor.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryAudit } from '../src/testing.ts'
import { addBrand, addUser, createStack, enrol, enrolledClient, signedInClient, totp, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
const RANDOM = '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b'

describe('resetting a second factor (the platform owner, with their own code)', () => {
  let stack: Stack
  let brand: string
  let owner: { client: TestClient; secret: string }
  let ownerId: string
  let admin: { client: TestClient; secret: string }
  let victimId: string
  let victim: TestClient

  const reset = (client: TestClient, target: string, body: Record<string, unknown>) =>
    client.request('POST', `/api/v1/users/${target}/second-factor/reset`, { body })

  beforeAll(async () => {
    stack = await createStack({ audit: new MemoryAudit() })
    brand = await addBrand(stack, 'brand-a')
    ownerId = await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
    await addUser(stack, { email: 'admin@example.test', password: PASSWORD, role: 'brand_admin', brandId: brand })
    victimId = await addUser(stack, { email: 'victim@example.test', password: PASSWORD, role: 'approver', brandId: brand })
    owner = await enrolledClient(stack, 'owner@example.test', PASSWORD)
    admin = await enrolledClient(stack, 'admin@example.test', PASSWORD)
    victim = (await enrolledClient(stack, 'victim@example.test', PASSWORD)).client
  })
  afterAll(async () => stack?.close())

  it('is for the platform owner only: a brand admin gets 403 before any code is looked at', async () => {
    const reply = await reset(admin.client, victimId, { code: '000000' })
    expect(reply.status).toBe(403)
    expect(reply.json.error.code).toBe('forbidden')
    expect((await stack.db.admin.query('select 1 from auth."twoFactor" where "userId" = $1', [victimId])).rowCount).toBe(1)
  })

  it('refuses a missing, wrong or another person’s code, and changes nothing', async () => {
    expect((await reset(owner.client, victimId, {})).status).toBe(400)
    expect((await reset(owner.client, victimId, { code: '000000' })).status).toBe(403)
    expect((await reset(owner.client, victimId, { code: totp(admin.secret) })).status).toBe(403)
    expect((await stack.db.admin.query('select 1 from auth."twoFactor" where "userId" = $1', [victimId])).rowCount).toBe(1)
  })

  it('refuses a reset of yourself, and answers 404 for someone who does not exist', async () => {
    const self = await reset(owner.client, ownerId, { code: totp(owner.secret) })
    expect(self.status).toBe(409)
    expect(self.json.error.code).toBe('cannot_reset_own_second_factor')
    expect((await reset(owner.client, RANDOM, { code: totp(owner.secret) })).status).toBe(404)
  })

  it('resets: the secret and backup codes are gone, sessions end, the person is told, and it is audited', async () => {
    const before = stack.mailer.sent.length
    const reply = await reset(owner.client, victimId, { code: totp(owner.secret) })
    expect(reply.status).toBe(204)
    expect((await stack.db.admin.query('select 1 from auth."twoFactor" where "userId" = $1', [victimId])).rowCount).toBe(0)
    const flag = await stack.db.admin.query('select "twoFactorEnabled" as on from auth."user" where id = $1', [victimId])
    expect(flag.rows[0].on).toBe(false)
    expect((await victim.request('GET', '/api/v1/session')).status).toBe(401)
    const mail = stack.mailer.sent.slice(before).find((m) => m.to === 'victim@example.test')
    expect(mail?.subject).toMatch(/second factor/i)
    const entry = stack.audit.entries.filter((e) => e.action === 'users.second_factor_reset').at(-1)!
    expect(entry).toMatchObject({ actor: ownerId, subject: victimId, outcome: 'success' })
    expect(JSON.stringify(stack.audit.entries)).not.toContain('victim@example.test')
  })

  it('makes the next sign-in need enrolment again: password only, then the gate, then a new second factor', async () => {
    const client = stack.newClient()
    const signIn = await client.signIn('victim@example.test', PASSWORD)
    expect(signIn.status).toBe(200)
    expect(signIn.json.twoFactorRedirect).toBeUndefined()
    const session = await client.request('GET', '/api/v1/session')
    expect(session.json).toMatchObject({ twoFactorEnabled: false, enrolmentRequired: true })
    expect((await client.request('GET', '/api/v1/brands')).json.error.code).toBe('enrolment_required')
    await enrol(client, PASSWORD)
    expect((await client.request('GET', '/api/v1/brands')).status).toBe(200)
  })

  it('rolls the reset back when the audit entry cannot be written (fail-closed)', async () => {
    class FailingAudit extends MemoryAudit {
      override async record(entry: Parameters<MemoryAudit['record']>[0]): Promise<void> {
        if (entry.action === 'users.second_factor_reset') throw new Error('audit is down')
        await super.record(entry)
      }
    }
    const failing = await createStack({ audit: new FailingAudit() })
    try {
      const b = await addBrand(failing, 'brand-f')
      await addUser(failing, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
      const target = await addUser(failing, { email: 'target@example.test', password: PASSWORD, role: 'approver', brandId: b })
      const o = await enrolledClient(failing, 'owner@example.test', PASSWORD)
      await enrolledClient(failing, 'target@example.test', PASSWORD)
      const reply = await o.client.request('POST', `/api/v1/users/${target}/second-factor/reset`, { body: { code: totp(o.secret) } })
      expect(reply.status).toBe(500)
      expect((await failing.db.admin.query('select 1 from auth."twoFactor" where "userId" = $1', [target])).rowCount).toBe(1)
    } finally {
      await failing.close()
    }
  })

  it('still resets when the notification cannot be sent, and reports it', async () => {
    const { ThrowingMailer } = await import('../src/testing.ts')
    const noMail = await createStack({ mailer: new ThrowingMailer() })
    try {
      const b = await addBrand(noMail, 'brand-n')
      await addUser(noMail, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
      const target = await addUser(noMail, { email: 'target@example.test', password: PASSWORD, role: 'viewer', brandId: b })
      await signedInClient(noMail, 'target@example.test', PASSWORD)
      const o = await enrolledClient(noMail, 'owner@example.test', PASSWORD)
      const reply = await o.client.request('POST', `/api/v1/users/${target}/second-factor/reset`, { body: { code: totp(o.secret) } })
      expect(reply.status).toBe(204)
      expect(noMail.logs.join('')).toContain('mail not sent')
    } finally {
      await noMail.close()
    }
  })
})
```

Keep one import block at the top (`ThrowingMailer` joins the existing `../src/testing.ts` import).

- [ ] **Step 2: Run to verify it fails**

Run (server): `npx vitest run apps/core/test/users-reset-second-factor.test.ts`
Expected: FAIL, the route answers 404.

- [ ] **Step 3: Add the service function**

Append to `apps/core/src/users/service.ts`:

```ts
// The platform owner resets a person's second factor (spec section 7). One transaction: the person's
// secret and backup codes, the enabled flag and every session go together, and so does the audit entry.
export async function resetSecondFactor(
  pool: Pool,
  audit: AuditSink,
  input: { actorId: string; targetId: string },
): Promise<{ email: string }> {
  if (input.actorId === input.targetId) {
    throw new AppError(
      409,
      'cannot_reset_own_second_factor',
      'The owner’s own second factor is reset by the documented server-side procedure.',
    )
  }
  const client = await pool.connect()
  try {
    await client.query('begin')
    const user = await client.query('select email from auth."user" where id = $1', [input.targetId])
    if (user.rowCount === 0) throw new AppError(404, 'not_found', 'There is nothing at this address.')
    await client.query('delete from auth."twoFactor" where "userId" = $1', [input.targetId])
    await client.query('update auth."user" set "twoFactorEnabled" = false where id = $1', [input.targetId])
    await client.query('delete from auth.session where "userId" = $1', [input.targetId])
    await audit.record({
      action: 'users.second_factor_reset',
      actor: input.actorId,
      subject: input.targetId,
      brandId: null,
      outcome: 'success',
    })
    await client.query('commit')
    return { email: user.rows[0].email as string }
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
```

- [ ] **Step 4: Add the route**

In `apps/core/src/routes/users.ts` import `resetSecondFactor` and add:

```ts
const userParams = z.strictObject({ userId: z.uuid() })

  // inside registerUserRoutes:
  table.add({
    method: 'post',
    path: '/users/:userId/second-factor/reset',
    access: { kind: 'platform_owner' },
    summary: 'Reset a person’s second factor (platform owner only; asks for the owner’s own code)',
    handlers: [
      validate({ params: userParams, body: removeBody }),
      async (req, res) => {
        const { body, params } = inputOf<{ body: z.infer<typeof removeBody>; params: z.infer<typeof userParams> }>(res)
        const actor = principalOf(res)
        await verifySecondFactorCode(deps.auth, req, body.code)
        const target = await resetSecondFactor(deps.pool, deps.audit, { actorId: actor.userId, targetId: params.userId })
        // After the reset is committed. A notification that cannot be sent is reported, never an error.
        try {
          await deps.mailer.send({
            to: target.email,
            subject: 'Your second factor was reset',
            text: 'The platform owner reset your second factor. You will be asked to set up a new one the next time you sign in. If you did not ask for this, contact the platform owner.',
          })
        } catch (error) {
          deps.onMailFailure?.(error)
        }
        res.status(204).end()
      },
    ],
  })
```

(`removeBody` is the `{ code }` schema from Task 7; reuse it. The `userParams` constant goes with the other constants at the top of the file.)

- [ ] **Step 5: Run to verify it passes**

Run (server): `npx vitest run apps/core`
Expected: PASS. If `delete from auth."twoFactor"` or `update auth."user"` is refused for `mkt_app`, the grants in migration 0006 are the cause: report it, do not edit the migration.

- [ ] **Step 6: Run every check and commit**

Run (server): `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`

```
git add apps/core
git commit -m "feat(users): the platform owner resets a second factor, with their own code; sessions end and the next sign-in enrols again"
```

---

### Task 9: Record, verify, and merge

**Files:**

- Modify: `docs/progress.md`
- Create: `docs/plans/m2c-permissions.docx` (generated)

**Interfaces:**

- Consumes: everything above
- Produces: the milestone record and the merge

- [ ] **Step 1: Run the whole suite twice and confirm nothing is left behind**

Run (server), twice: `npm ci && npm run verify`
Expected both times: every step passes, including `npm run secrets`. Confirm no test database is left behind (`ssh root@<dev-server> "docker exec mkt-dev-postgres-1 psql -U mkt -d postgres -Atc \"select count(*) from pg_database where datname like 'mkt_t_%'\""` prints `0`) and that the suite shows no library warning lines.

- [ ] **Step 2: Scan the branch for the server address**

Run: `git log main..HEAD -p | grep -c '<the server address>'`. Expected: `0`. Fix any occurrence before pushing (rewrite the unpushed commits).

- [ ] **Step 3: Record the milestone**

Append to `docs/progress.md` a section "Phase 1, milestone 2c: Permissions" in the style of the earlier sections: the commit range (`git log --oneline main..HEAD`); package 5 done; the acceptance tests proven (13 in full: the PRD matrix test, the declaration test and the role-matrix test; 1 for every brand-scoped route that exists, by a test that reads the route table, and what is still to come: the content, approval and agent routes of later milestones; SEC-2); what is not proven and why (acceptance test 6 needs the worker, test 8's read-only half is covered for Viewers by the role matrix and the screen side waits for the dashboard); the seven decisions as accepted by the owner on the date they were; every ruling made during the work, in plain words, rulings first; the findings (for example what the library's TOTP check did for a signed-in person); the deployment preconditions carried from 2b (trust proxy, the library's client-address setting); and the follow-ups carried forward (the owner's all-brands list under the owner-view role; the kill switch and data export use the same table and code check; cancelling a pending invite; real mail in package 11). Run `npx prettier --check docs/progress.md` on the server.

- [ ] **Step 4: Make the Word copy of this plan**

Run (server): `cd tools/build-docs && PUPPETEER_SKIP_DOWNLOAD=1 npm ci --ignore-scripts && node md2docx.js ../../docs/plans/2026-10-04-m2c-permissions.md /work/.m2c-plan.docx`, copy it to `docs/plans/m2c-permissions.docx` and delete the temporary file on the server. The Markdown stays canonical; regenerate the Word copy if the plan text changes.

- [ ] **Step 5: Commit, push, open the pull request, wait for CI, merge**

```
git add docs
git commit -m "docs: milestone 2c results"
git push -u origin m2c-permissions
gh pr create --base main --head m2c-permissions --title "Milestone 2c: permissions (package 5)" --body-file <description>
```

The description states what was added, the decisions the owner accepted, every ruling and finding, what was run (the two verify runs), what is not proven, and the deployment preconditions; it ends with the attribution line the session gives. Wait for the pull request's workflow run to succeed, then merge with a merge commit (`gh pr merge --merge`): the owner's standing instruction (2026-10-04) is to push and merge without asking once the checks pass and the reviews are clean. If the merge is refused by a permission rule, stop and tell the owner; do not work around it.

- [ ] **Step 6: Report to the owner**

State what passed, every ruling and finding, anything that differs from this plan, and what is not proven yet.
