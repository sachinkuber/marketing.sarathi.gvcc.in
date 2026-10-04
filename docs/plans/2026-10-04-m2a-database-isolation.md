# Milestone 2a (Database and isolation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the owner chose native execution) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A database where two brands exist and one brand's data cannot be read or written through another brand's session, proven by tests against every run-time database role.

**Architecture:** One new package, `packages/db`, holds plain SQL migrations, the role definitions, the `withBrand` helper and a test harness that builds a throw-away database per test run. Row-level security is forced on every brand-scoped table. Milestone 2 is split into three plans: this one (phase 1 spec package 2), then the core service shell and sign-in (packages 3 and 4), then permissions (package 5).

**Tech Stack:** PostgreSQL 17.11, node-pg-migrate 8.0.4, pg 8.23.0, Vitest 4.1.11, ESLint 10.10.0, Node 24.20.0 (all run on the development server, see `docs/dev-environment.md`).

**Spec:** `docs/specs/2026-10-04-phase-1-foundation.md` (version 5) sections 5 and 6, package 2. Columns, types and rules: `docs/database/2026-10-04-database-schema.md` (version 2) sections 2, 3, 5, 6 and 11. Acceptance tests proven here: 2, 3, 4, 5 (the role-rights part), 7. Test 1 (every API operation) and test 6 (attempt tokens) need code from later milestones.

## Global Constraints

- Everything from the milestone 1 plan still holds: exact pins, committed lockfile, no secret committed, n8n untouched, nothing installed on the owner's laptop. Commands run through `/opt/mkt-dev/run.sh` on `root@<dev-server>` after an `rsync` of the project (see `docs/dev-environment.md`).
- Identifiers are random `uuid` (`gen_random_uuid()`), time is `timestamptz`, names are lower case with underscores, tables are singular.
- Every brand-scoped table has `brand_id uuid not null`, a unique key on `(brand_id, id)` when it has an `id`, forced row-level security with one policy `brand_isolation` having both `USING` and `WITH CHECK` equal to `brand_id = current_setting('app.brand_id', true)::uuid`, and every foreign key to another brand-scoped table includes `brand_id`.
- No run-time role owns a table or can bypass row-level security. The application role cannot create or alter tables.
- Columns that refer to a user (`user_id`, `created_by`, `decided_by` and so on) are plain `uuid` in this milestone. The foreign key to `auth.user` is added by the sign-in migration, because the sign-in library creates that table (database schema section 4).
- Tables for jobs, cost, notifications, alerts and the audit log are created in the milestone that uses them (4, 3 and 5), with the same rules. The generic tests below find them automatically.
- Roles are named `mkt_migration`, `mkt_app`, `mkt_queue`, `mkt_audit_writer`, `mkt_owner_view`, `mkt_readonly` and `mkt_definer`. `mkt_definer` owns the named functions and has no login.

## Review Focus

1. **A table added later without forced row-level security or without `brand_id` in a foreign key**: the catalog tests (Task 4) read every table in `app` and fail on it, so a future table cannot slip past. Tasks 3 and 4.
2. **No brand set**: a query returns no rows and an insert fails, for the application and read-only roles. Task 4.
3. **A row moved to another brand by `UPDATE`** (not only inserted into one). Task 4.
4. **The brand setting leaking to the next user of a pooled connection**: `withBrand` is tested on a pool of one connection. Task 5.
5. **A direct database import in application code** (test 7): the lint rule must fail on it and pass inside `packages/db`. Task 5.

---

### Task 1: The db package, the migration runner and the test database

**Files:**
- Create: `packages/db/package.json`, `packages/db/src/migrate.ts`, `packages/db/src/testing.ts`, `packages/db/migrations/0001_schemas_roles.sql`
- Test: `packages/db/test/harness.test.ts`
- Modify: `tsconfig.json` (nothing needed; `packages/*/src` and `packages/*/test` are already included)

**Interfaces:**
- Consumes: `databaseUrl`, `requireDatabase` from `@mkt/test-support`
- Produces: `migrate(url: string): Promise<void>` from `packages/db/src/migrate.ts`; from `packages/db/src/testing.ts`: `createTestDatabase(): Promise<TestDatabase>` where `TestDatabase = { name: string; urlFor(role: RoleName | 'migration'): string; admin: pg.Pool; drop(): Promise<void> }`, and `type RoleName = 'app' | 'queue' | 'audit_writer' | 'owner_view' | 'readonly'`.

- [ ] **Step 1: Write the failing harness test**

`packages/db/test/harness.test.ts`:
```ts
import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../src/testing.ts'

describe('test database', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
  })
  afterAll(async () => db.drop())

  it('is migrated, with the four schemas the spec names that exist so far', async () => {
    const result = await db.admin.query(
      "select schema_name from information_schema.schemata where schema_name in ('app','audit','secrets') order by 1",
    )
    expect(result.rows.map((r) => r.schema_name)).toEqual(['app', 'audit'])
  })

  it('has seven roles and none of the run-time ones is a superuser or bypasses row-level security', async () => {
    const result = await db.admin.query(
      "select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname like 'mkt\\_%' order by 1",
    )
    const byName = Object.fromEntries(result.rows.map((r) => [r.rolname, r]))
    expect(Object.keys(byName).sort()).toEqual([
      'mkt_app',
      'mkt_audit_writer',
      'mkt_definer',
      'mkt_migration',
      'mkt_owner_view',
      'mkt_queue',
      'mkt_readonly',
    ])
    for (const [name, role] of Object.entries(byName)) {
      expect(role.rolsuper, name).toBe(false)
      expect(role.rolbypassrls, name).toBe(false)
    }
    expect(byName.mkt_definer.rolcanlogin).toBe(false)
  })

  it('lets the application role connect and refuses it creating a table', async () => {
    const client = new pg.Client({ connectionString: db.urlFor('app') })
    await client.connect()
    try {
      await expect(client.query('create table app.nope (id int)')).rejects.toMatchObject({ code: '42501' })
    } finally {
      await client.end()
    }
  })
})
```

- [ ] **Step 2: Create the package file and install**

`packages/db/package.json`:
```json
{
  "name": "@mkt/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts"
  },
  "dependencies": {
    "@mkt/test-support": "*",
    "node-pg-migrate": "8.0.4",
    "pg": "8.23.0"
  },
  "devDependencies": {
    "@types/pg": "8.23.1"
  }
}
```
Run (on the server): `npm install`. Expected: succeeds. Then `npx vitest run packages/db`. Expected: FAIL, cannot find `../src/testing.ts`.

- [ ] **Step 3: Write the first migration: schemas and roles**

`packages/db/migrations/0001_schemas_roles.sql`:
```sql
-- Up Migration
create schema app;
create schema audit;

do $$
declare r text;
begin
  foreach r in array array['mkt_app','mkt_queue','mkt_audit_writer','mkt_owner_view','mkt_readonly','mkt_definer'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;

revoke all on schema app from public;
revoke all on schema audit from public;
grant usage on schema app to mkt_app, mkt_readonly, mkt_definer, mkt_owner_view;

-- Down Migration
drop schema audit;
drop schema app;
```
The migration role (`mkt_migration`) is created by the test harness and, in production, by the deployment procedure, because a migration cannot create the role that runs it.

- [ ] **Step 4: Write the migration runner**

`packages/db/src/migrate.ts`:
```ts
import { runner } from 'node-pg-migrate'
import { join } from 'node:path'

const migrationsDir = join(import.meta.dirname, '..', 'migrations')

export async function migrate(databaseUrl: string): Promise<void> {
  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    migrationsSchema: 'public',
    createSchema: false,
    log: () => undefined,
  })
}
```
`packages/db/src/index.ts`:
```ts
export { migrate } from './migrate.ts'
```

- [ ] **Step 5: Write the test-database harness**

`packages/db/src/testing.ts`:
```ts
import { databaseUrl } from '@mkt/test-support'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { migrate } from './migrate.ts'

export type RoleName = 'app' | 'queue' | 'audit_writer' | 'owner_view' | 'readonly'
export const RUNTIME_ROLES: RoleName[] = ['app', 'queue', 'audit_writer', 'owner_view', 'readonly']

export interface TestDatabase {
  name: string
  urlFor(role: RoleName | 'migration'): string
  admin: pg.Pool
  drop(): Promise<void>
}

// Local development passwords only. Production roles get their own secrets at deployment.
const password = (role: string) => `dev_only_${role}`

function urlWith(base: string, database: string, user?: string, pass?: string): string {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) {
    url.username = user
    url.password = pass ?? ''
  }
  return url.toString()
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `mkt_t_${randomBytes(5).toString('hex')}`
  const superuser = new pg.Client({ connectionString: databaseUrl })
  await superuser.connect()
  try {
    const exists = await superuser.query("select 1 from pg_roles where rolname = 'mkt_migration'")
    if (exists.rowCount === 0) {
      await superuser.query(`create role mkt_migration login createrole password '${password('migration')}'`)
    }
    await superuser.query(`create database ${name} owner mkt_migration`)
  } finally {
    await superuser.end()
  }

  await migrate(urlWith(databaseUrl, name, 'mkt_migration', password('migration')))

  // Give the run-time roles a login. The migration only creates them without one.
  const admin = new pg.Pool({ connectionString: urlWith(databaseUrl, name), max: 2 })
  for (const role of RUNTIME_ROLES) {
    await admin.query(`alter role mkt_${role} login password '${password(role)}'`)
  }

  return {
    name,
    urlFor: (role) =>
      urlWith(databaseUrl, name, `mkt_${role}`, password(role)),
    admin,
    async drop() {
      await admin.end()
      const client = new pg.Client({ connectionString: databaseUrl })
      await client.connect()
      try {
        await client.query(`drop database if exists ${name} with (force)`)
      } finally {
        await client.end()
      }
    },
  }
}
```
Note: `urlWith` for the migration role uses `password('migration')`; `urlFor('migration')` therefore resolves to `mkt_migration`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/db`
Expected: PASS, 3 tests. If `runner` is not a named export in node-pg-migrate 8.0.4, use its default export and record a ruling.

- [ ] **Step 7: Run every check and commit**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`
Expected: all pass.
```
git add packages/db package-lock.json
git commit -m "feat(db): migration runner, schemas, roles and a test database harness"
```

---

### Task 2: Tenancy and access tables

**Files:**
- Create: `packages/db/migrations/0002_enums_tenancy.sql`
- Test: `packages/db/test/tenancy.test.ts`

**Interfaces:**
- Consumes: `createTestDatabase` from Task 1
- Produces: tables `app.brand`, `app.platform_owner`, `app.membership`, `app.invite`, `app.approval_setting`, `app.kill_switch`; the enumerated types from database schema section 3.3; and the helper `withBrandSql(brandId)` is NOT here (Task 5).

- [ ] **Step 1: Write the failing test**

`packages/db/test/tenancy.test.ts`:
```ts
import { requireDatabase } from '@mkt/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../src/testing.ts'

describe('tenancy tables', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
  })
  afterAll(async () => db.drop())

  it('has every enumerated type from the schema document', async () => {
    const result = await db.admin.query(
      "select typname from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'app' and t.typtype = 'e' order by 1",
    )
    expect(result.rows.map((r) => r.typname)).toEqual([
      'action_state',
      'actor_kind',
      'approval_decision',
      'attempt_state',
      'brand_status',
      'check_kind',
      'content_kind',
      'job_class',
      'kill_scope',
      'membership_role',
      'model_call_status',
      'notification_state',
      'popup_choice',
      'run_state',
      'version_state',
    ])
  })

  it('has the six tenancy tables', async () => {
    const result = await db.admin.query(
      "select tablename from pg_tables where schemaname = 'app' order by 1",
    )
    expect(result.rows.map((r) => r.tablename)).toEqual([
      'approval_setting',
      'brand',
      'invite',
      'kill_switch',
      'membership',
      'platform_owner',
    ])
  })

  it('refuses a second active kill switch for the same brand, scope and target', async () => {
    const client = await db.admin.connect()
    try {
      await client.query('begin')
      await client.query("select set_config('app.brand_id', '00000000-0000-4000-8000-0000000000a1', true)")
      await client.query("set local role mkt_migration")
      await client.query(
        "insert into app.brand (id, name, slug, schedule_key) values ('00000000-0000-4000-8000-0000000000a1','A','a',gen_random_uuid())",
      )
      const kill = `insert into app.kill_switch (brand_id, scope, target, active, set_by) values ('00000000-0000-4000-8000-0000000000a1','channel','instagram',true,gen_random_uuid())`
      await client.query(kill)
      await expect(client.query(kill)).rejects.toMatchObject({ code: '23505' })
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
  })

  it('refuses a reminder count outside 1 to 5 and a slug with capitals', async () => {
    const client = await db.admin.connect()
    try {
      await client.query('begin')
      await client.query("set local role mkt_migration")
      await client.query("select set_config('app.brand_id', '00000000-0000-4000-8000-0000000000b1', true)")
      await expect(
        client.query(
          "insert into app.brand (id, name, slug, schedule_key) values ('00000000-0000-4000-8000-0000000000b1','B','Bad Slug',gen_random_uuid())",
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
    const client2 = await db.admin.connect()
    try {
      await client2.query('begin')
      await client2.query("set local role mkt_migration")
      await client2.query("select set_config('app.brand_id', '00000000-0000-4000-8000-0000000000b2', true)")
      await client2.query(
        "insert into app.brand (id, name, slug, schedule_key) values ('00000000-0000-4000-8000-0000000000b2','B','b-two',gen_random_uuid())",
      )
      await expect(
        client2.query(
          "insert into app.approval_setting (brand_id, reminder_count) values ('00000000-0000-4000-8000-0000000000b2', 6)",
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await client2.query('rollback').catch(() => undefined)
      client2.release()
    }
  })
})
```
`db.admin` connects as the cluster superuser; `set local role mkt_migration` makes the statement run as the table owner so forced row-level security applies, as it will in production.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/db/test/tenancy.test.ts`
Expected: FAIL, the enumerated-types test finds none.

- [ ] **Step 3: Write the migration**

`packages/db/migrations/0002_enums_tenancy.sql`:
```sql
-- Up Migration
create type app.brand_status as enum ('onboarding','active','paused','offboarding','closed');
create type app.membership_role as enum ('brand_admin','approver','sales_contact','viewer');
create type app.content_kind as enum ('summary','article','answer_page','social_post','carousel','short_video','long_video','email','ad','landing_page','reply','strategy_brief','campaign','correction');
create type app.version_state as enum ('draft','in_checks','check_failed','awaiting_approval','approved','rejected','superseded','invalidated','scheduled','publish_unknown','published','withdrawn');
create type app.check_kind as enum ('blocking','score');
create type app.approval_decision as enum ('approved','rejected','changes_requested');
create type app.run_state as enum ('created','running','succeeded','failed','needs_manual','cancelled','held');
create type app.job_class as enum ('interactive','publishing','production','bulk');
create type app.attempt_state as enum ('active','succeeded','failed','superseded');
create type app.model_call_status as enum ('started','succeeded','failed','unknown');
create type app.kill_scope as enum ('brand','channel','agent');
create type app.action_state as enum ('pending','submitted','confirmed','failed','unknown');
create type app.notification_state as enum ('queued','sent','delivered','failed');
create type app.popup_choice as enum ('review_now','later');
create type app.actor_kind as enum ('user','agent','system','n8n');
create extension if not exists citext;

create table app.brand (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status app.brand_status not null default 'onboarding',
  shadow_mode boolean not null default false,
  schedule_key uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.platform_owner (
  user_id uuid primary key,
  granted_at timestamptz not null default now(),
  granted_by uuid
);

create table app.membership (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references app.brand (id),
  user_id uuid not null,
  role app.membership_role not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (brand_id, id),
  unique (brand_id, user_id)
);
create index membership_user_idx on app.membership (user_id);

create table app.invite (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references app.brand (id),
  email citext not null,
  role app.membership_role not null,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  invited_by uuid not null,
  created_at timestamptz not null default now(),
  unique (brand_id, id)
);

create table app.approval_setting (
  brand_id uuid primary key references app.brand (id),
  first_reminder_after interval not null default interval '24 hours',
  reminder_gap interval not null default interval '24 hours',
  reminder_count smallint not null default 3 check (reminder_count between 1 and 5),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table app.kill_switch (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references app.brand (id),
  scope app.kill_scope not null,
  target text,
  active boolean not null,
  set_by uuid not null,
  set_at timestamptz not null default now(),
  released_by uuid,
  released_at timestamptz,
  unique (brand_id, id),
  check ((scope = 'brand') = (target is null))
);
create unique index kill_switch_one_active
  on app.kill_switch (brand_id, scope, coalesce(target, '')) where active;

-- Down Migration
drop table app.kill_switch;
drop table app.approval_setting;
drop table app.invite;
drop table app.membership;
drop table app.platform_owner;
drop table app.brand;
drop type app.actor_kind, app.popup_choice, app.notification_state, app.action_state, app.kill_scope,
  app.model_call_status, app.attempt_state, app.job_class, app.run_state, app.approval_decision,
  app.check_kind, app.version_state, app.content_kind, app.membership_role, app.brand_status;
```
Row-level security and the grants for these tables come in Task 4, so that one migration applies the identical policy to every table (Task 3 adds the content tables first).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/db/test/tenancy.test.ts packages/db/test/harness.test.ts`
Expected: PASS. The harness test about the two schemas still passes.

- [ ] **Step 5: Commit**

```
git add packages/db
git commit -m "feat(db): enumerated types and tenancy tables"
```

---

### Task 3: Content and approval tables

**Files:**
- Create: `packages/db/migrations/0003_content_approvals.sql`
- Test: `packages/db/test/content-tables.test.ts`

**Interfaces:**
- Consumes: Task 2 types and `app.brand`
- Produces: `app.content_item`, `app.content_version`, `app.content_version_state`, `app.content_version_state_change`, `app.asset`, `app.check_result`, `app.approval`, `app.approval_invalidation`, `app.approval_request`, `app.popup_ack`, `app.outbox_action`.

- [ ] **Step 1: Write the failing test**

`packages/db/test/content-tables.test.ts`:
```ts
import { requireDatabase } from '@mkt/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../src/testing.ts'

describe('content and approval tables', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
  })
  afterAll(async () => db.drop())

  it('has the eleven content and approval tables as well as the six tenancy tables', async () => {
    const result = await db.admin.query("select tablename from pg_tables where schemaname = 'app' order by 1")
    expect(result.rows.map((r) => r.tablename)).toEqual([
      'approval',
      'approval_invalidation',
      'approval_request',
      'approval_setting',
      'asset',
      'brand',
      'check_result',
      'content_item',
      'content_version',
      'content_version_state',
      'content_version_state_change',
      'invite',
      'kill_switch',
      'membership',
      'outbox_action',
      'platform_owner',
      'popup_ack',
    ])
  })

  it('refuses a blocking check with a score and a score check with neither a score nor an N/A reason', async () => {
    const client = await db.admin.connect()
    try {
      await client.query('begin')
      await client.query('set local role mkt_migration')
      const brand = '00000000-0000-4000-8000-0000000000c1'
      await client.query("select set_config('app.brand_id', $1, true)", [brand])
      await client.query("insert into app.brand (id, name, slug) values ($1,'C','c-brand')", [brand])
      const item = '00000000-0000-4000-8000-0000000000c2'
      const version = '00000000-0000-4000-8000-0000000000c3'
      await client.query("insert into app.content_item (id, brand_id, kind) values ($1,$2,'summary')", [item, brand])
      await client.query(
        "insert into app.content_version (id, brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by_kind) values ($1,$2,$3,1,'{}','sha256:x','cv1','system')",
        [version, brand, item],
      )
      await client.query('savepoint a')
      await expect(
        client.query(
          "insert into app.check_result (brand_id, content_version_id, check_name, kind, passed, score) values ($1,$2,'accuracy','blocking',true,4)",
          [brand, version],
        ),
      ).rejects.toMatchObject({ code: '23514' })
      await client.query('rollback to savepoint a')
      await expect(
        client.query(
          "insert into app.check_result (brand_id, content_version_id, check_name, kind) values ($1,$2,'brand_voice','score')",
          [brand, version],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/db/test/content-tables.test.ts`
Expected: FAIL, the table list lacks the content tables.

- [ ] **Step 3: Write the migration**

`packages/db/migrations/0003_content_approvals.sql`:
```sql
-- Up Migration
create table app.content_item (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references app.brand (id),
  kind app.content_kind not null,
  current_version_id uuid,
  created_at timestamptz not null default now(),
  unique (brand_id, id)
);

create table app.content_version (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  content_item_id uuid not null,
  number integer not null check (number >= 1),
  payload_canonical text not null,
  hash text not null,
  hash_scheme text not null,
  provenance jsonb,
  created_by_kind app.actor_kind not null,
  created_by_user uuid,
  created_by_run uuid,
  created_at timestamptz not null default now(),
  unique (brand_id, id),
  unique (content_item_id, number),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, content_item_id) references app.content_item (brand_id, id)
);
create index content_version_item_idx on app.content_version (brand_id, content_item_id, number);

alter table app.content_item
  add constraint content_item_current_version_fk
  foreign key (brand_id, current_version_id) references app.content_version (brand_id, id)
  deferrable initially deferred;

create table app.content_version_state (
  content_version_id uuid primary key,
  brand_id uuid not null,
  state app.version_state not null,
  updated_at timestamptz not null default now(),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, content_version_id) references app.content_version (brand_id, id)
);
create index content_version_state_idx on app.content_version_state (brand_id, state);

create table app.content_version_state_change (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  content_version_id uuid not null,
  from_state app.version_state,
  to_state app.version_state not null,
  cause text not null,
  actor_kind app.actor_kind not null,
  actor_id uuid,
  at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, content_version_id) references app.content_version (brand_id, id)
);

create table app.asset (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references app.brand (id),
  sha256 text not null,
  byte_length bigint not null check (byte_length >= 0),
  mime text not null,
  storage_key text not null,
  ai_generated boolean not null,
  created_at timestamptz not null default now(),
  unique (brand_id, id),
  unique (brand_id, sha256)
);

create table app.check_result (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  content_version_id uuid not null,
  check_name text not null,
  kind app.check_kind not null,
  passed boolean,
  score smallint check (score between 1 and 5),
  not_applicable boolean not null default false,
  not_applicable_reason text,
  confidence smallint check (confidence between 0 and 100),
  detail jsonb,
  definition_version_id uuid,
  created_at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, content_version_id) references app.content_version (brand_id, id),
  check (not_applicable = false or not_applicable_reason is not null),
  check (
    (kind = 'blocking' and passed is not null and score is null)
    or (kind = 'score' and (score is not null or not_applicable))
  )
);

create table app.approval (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  content_version_id uuid not null,
  version_hash text not null,
  hash_scheme text not null,
  decision app.approval_decision not null,
  decided_by uuid not null,
  comment text,
  decided_at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, content_version_id) references app.content_version (brand_id, id)
);

create table app.approval_invalidation (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  approval_id uuid not null unique,
  reason text not null,
  at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, approval_id) references app.approval (brand_id, id)
);

create table app.approval_request (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  content_version_id uuid not null unique,
  requested_at timestamptz not null default now(),
  reminders_sent smallint not null default 0,
  last_reminder_at timestamptz,
  escalated_at timestamptz,
  escalated_to uuid,
  overdue boolean not null default false,
  closed_at timestamptz,
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, content_version_id) references app.content_version (brand_id, id)
);
create index approval_request_open_idx on app.approval_request (brand_id) where closed_at is null;
create index approval_request_overdue_idx on app.approval_request (brand_id) where overdue;

create table app.popup_ack (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  user_id uuid not null,
  approval_request_id uuid not null,
  choice app.popup_choice not null,
  at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, approval_request_id) references app.approval_request (brand_id, id)
);

create table app.outbox_action (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  kind text not null,
  content_version_id uuid,
  approval_id uuid,
  state app.action_state not null default 'pending',
  idempotency_key uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, content_version_id) references app.content_version (brand_id, id),
  foreign key (brand_id, approval_id) references app.approval (brand_id, id)
);

-- Down Migration
drop table app.outbox_action, app.popup_ack, app.approval_request, app.approval_invalidation, app.approval,
  app.check_result, app.asset, app.content_version_state_change, app.content_version_state;
alter table app.content_item drop constraint content_item_current_version_fk;
drop table app.content_version, app.content_item;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/db`
Expected: PASS. If the hash value `sha256:x` is refused, the hash trigger has been added early; it belongs to milestone 3, so report it.

- [ ] **Step 5: Commit**

```
git add packages/db
git commit -m "feat(db): content and approval tables with brand-carrying foreign keys"
```

---

### Task 4: Row-level security, grants and the isolation tests (acceptance tests 2, 3, 4, 5)

**Files:**
- Create: `packages/db/migrations/0004_rls_grants.sql`
- Test: `packages/db/test/isolation-catalog.test.ts`, `packages/db/test/isolation-behaviour.test.ts`
- Create: `packages/db/src/seed.ts` (test-only seeding helper, exported from `testing.ts`)

**Interfaces:**
- Consumes: Tasks 1 to 3
- Produces: forced row-level security and policy `brand_isolation` on every table in `app` that has a `brand_id` column; grants per role (database schema section 11.1); from `testing.ts`: `seedBrand(db: TestDatabase, id: string, slug: string): Promise<void>` which creates the brand, its membership, one invite, one content item, one version and one kill-switch row for that brand using the migration role with the brand set.

- [ ] **Step 1: Write the failing catalog test**

`packages/db/test/isolation-catalog.test.ts`:
```ts
import { requireDatabase } from '@mkt/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../src/testing.ts'

const POLICY = "(brand_id = (current_setting('app.brand_id'::text, true))::uuid)"

describe('every brand-scoped table follows the rules (acceptance tests 3 and 4)', () => {
  let db: TestDatabase
  let scoped: string[]
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    const r = await db.admin.query(
      "select table_name from information_schema.columns where table_schema = 'app' and column_name = 'brand_id' order by 1",
    )
    scoped = r.rows.map((x) => x.table_name)
  })
  afterAll(async () => db.drop())

  it('finds the brand-scoped tables, so the tests below cannot pass on an empty list', () => {
    expect(scoped.length).toBeGreaterThanOrEqual(15)
    expect(scoped).toContain('content_version')
    expect(scoped).not.toContain('brand')
  })

  it('has row-level security enabled and forced on each', async () => {
    const r = await db.admin.query(
      "select relname, relrowsecurity, relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r' and c.relname = any($1)",
      [scoped],
    )
    expect(r.rowCount).toBe(scoped.length)
    for (const row of r.rows) {
      expect(row.relrowsecurity, row.relname).toBe(true)
      expect(row.relforcerowsecurity, row.relname).toBe(true)
    }
  })

  it('has one policy brand_isolation per table with the same read and write condition', async () => {
    const r = await db.admin.query(
      "select tablename, policyname, qual, with_check, cmd from pg_policies where schemaname = 'app' and tablename = any($1) and policyname = 'brand_isolation'",
      [scoped],
    )
    expect(r.rowCount).toBe(scoped.length)
    for (const row of r.rows) {
      expect(row.cmd, row.tablename).toBe('ALL')
      expect(row.qual, row.tablename).toBe(POLICY)
      expect(row.with_check, row.tablename).toBe(POLICY)
    }
  })

  it('has a unique key on (brand_id, id) wherever a table has an id', async () => {
    const withId = await db.admin.query(
      "select table_name from information_schema.columns where table_schema = 'app' and column_name = 'id' and table_name = any($1)",
      [scoped],
    )
    for (const { table_name } of withId.rows) {
      const r = await db.admin.query(
        `select 1 from pg_constraint c where c.conrelid = ('app.' || $1)::regclass and c.contype = 'u'
           and (select array_agg(a.attname order by a.attname) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) = array['brand_id','id']::name[]`,
        [table_name],
      )
      expect(r.rowCount, table_name).toBe(1)
    }
  })

  it('has brand_id in every foreign key between brand-scoped tables, on both sides', async () => {
    const r = await db.admin.query(
      `select c.conname, c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
              array(select a.attname from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) as child_cols,
              array(select a.attname from pg_attribute a where a.attrelid = c.confrelid and a.attnum = any(c.confkey)) as parent_cols
         from pg_constraint c
        where c.contype = 'f' and c.connamespace = 'app'::regnamespace`,
    )
    const names = new Set(scoped.map((t) => `app.${t}`))
    const between = r.rows.filter((x) => names.has(x.child) && names.has(x.parent))
    expect(between.length).toBeGreaterThanOrEqual(10)
    for (const fk of between) {
      expect(fk.child_cols, `${fk.conname} child`).toContain('brand_id')
      expect(fk.parent_cols, `${fk.conname} parent`).toContain('brand_id')
    }
  })
})
```
`information_schema.columns` returns the first table named `brand_id`-bearing; the `app.brand` table has `id` only, so it is excluded.

- [ ] **Step 2: Write the failing behaviour test**

`packages/db/test/isolation-behaviour.test.ts`:
```ts
import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, RUNTIME_ROLES, seedBrand, type RoleName, type TestDatabase } from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
// Tables seeded by seedBrand. The catalog test proves the same policy exists on all the others.
const SEEDED = ['membership', 'invite', 'content_item', 'content_version', 'kill_switch']

async function as<T>(db: TestDatabase, role: RoleName, brand: string | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: db.urlFor(role) })
  await client.connect()
  try {
    await client.query('begin')
    if (brand) await client.query("select set_config('app.brand_id', $1, true)", [brand])
    return await fn(client)
  } finally {
    await client.query('rollback').catch(() => undefined)
    await client.end()
  }
}

describe('tenant isolation in the database (acceptance tests 2, 3 and 5)', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    await seedBrand(db, A, 'brand-a')
    await seedBrand(db, B, 'brand-b')
  })
  afterAll(async () => db.drop())

  for (const table of SEEDED) {
    it(`the application role sees only its own brand's rows in ${table}`, async () => {
      const own = await as(db, 'app', A, (c) => c.query(`select distinct brand_id from app.${table}`))
      expect(own.rows.map((r) => r.brand_id)).toEqual([A])
    })

    it(`the read-only role sees only its own brand's rows in ${table}`, async () => {
      const own = await as(db, 'readonly', B, (c) => c.query(`select distinct brand_id from app.${table}`))
      expect(own.rows.map((r) => r.brand_id)).toEqual([B])
    })

    it(`with no brand set, the application and read-only roles see no rows in ${table}`, async () => {
      for (const role of ['app', 'readonly'] as const) {
        const none = await as(db, role, null, (c) => c.query(`select count(*)::int as n from app.${table}`))
        expect(none.rows[0].n, `${role} ${table}`).toBe(0)
      }
    })
  }

  it('the brand table shows a session only its own brand', async () => {
    const r = await as(db, 'app', A, (c) => c.query('select id from app.brand'))
    expect(r.rows.map((x) => x.id)).toEqual([A])
  })

  it('the queue, audit-writer and owner-view roles cannot read any business table', async () => {
    for (const role of ['queue', 'audit_writer', 'owner_view'] as const) {
      for (const table of [...SEEDED, 'brand', 'approval_setting']) {
        await expect(
          as(db, role, A, (c) => c.query(`select 1 from app.${table} limit 1`)),
          `${role} ${table}`,
        ).rejects.toMatchObject({ code: '42501' })
      }
    }
  })

  it('has every run-time role covered by the checks above', () => {
    expect(RUNTIME_ROLES.sort()).toEqual(['app', 'audit_writer', 'owner_view', 'queue', 'readonly'])
  })

  it('refuses an insert that carries another brand, in every seeded table the application role can write', async () => {
    await expect(
      as(db, 'app', A, (c) =>
        c.query("insert into app.membership (brand_id, user_id, role) values ($1, gen_random_uuid(), 'viewer')", [B]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      as(db, 'app', A, (c) => c.query("insert into app.content_item (brand_id, kind) values ($1, 'summary')", [B])),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses an update that moves a row to another brand', async () => {
    await expect(
      as(db, 'app', A, (c) => c.query('update app.content_item set brand_id = $1 where brand_id = $2', [B, A])),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses any insert when no brand is set', async () => {
    await expect(
      as(db, 'app', null, (c) => c.query("insert into app.content_item (brand_id, kind) values ($1, 'summary')", [A])),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses a row in brand A pointing at a parent row in brand B', async () => {
    const parent = await as(db, 'app', B, (c) => c.query('select id from app.content_item limit 1'))
    await expect(
      as(db, 'app', A, (c) =>
        c.query(
          "insert into app.content_version (brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by_kind) values ($1, $2, 99, '{}', 'sha256:x', 'cv1', 'system')",
          [A, parent.rows[0].id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('cannot be bypassed by the application role creating or altering a table', async () => {
    await expect(as(db, 'app', A, (c) => c.query('alter table app.membership disable row level security'))).rejects.toMatchObject({
      code: '42501',
    })
  })
})
```

- [ ] **Step 3: Write the seeding helper**

Add to the end of `packages/db/src/testing.ts`:
```ts
// Creates a brand and one row in each of the main brand-scoped tables, as the table owner, with the brand set.
export async function seedBrand(db: TestDatabase, id: string, slug: string): Promise<void> {
  const client = new pg.Client({ connectionString: db.urlFor('migration') })
  await client.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('app.brand_id', $1, true)", [id])
    await client.query('insert into app.brand (id, name, slug) values ($1, $2, $2)', [id, slug])
    await client.query("insert into app.membership (brand_id, user_id, role) values ($1, gen_random_uuid(), 'approver')", [id])
    await client.query(
      "insert into app.invite (brand_id, email, role, token_hash, expires_at, invited_by) values ($1, $2, 'viewer', gen_random_bytes(32), now() + interval '72 hours', gen_random_uuid())",
      [id, `${slug}@example.test`],
    )
    const item = await client.query("insert into app.content_item (brand_id, kind) values ($1, 'summary') returning id", [id])
    await client.query(
      "insert into app.content_version (brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by_kind) values ($1, $2, 1, '{}', 'sha256:x', 'cv1', 'system')",
      [id, item.rows[0].id],
    )
    await client.query("insert into app.kill_switch (brand_id, scope, active, set_by) values ($1, 'brand', false, gen_random_uuid())", [id])
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}
```
`gen_random_bytes` needs the `pgcrypto` extension: add `create extension if not exists pgcrypto;` to the first migration if the call fails, and record a ruling.

- [ ] **Step 4: Run both to verify they fail**

Run: `npx vitest run packages/db/test/isolation-catalog.test.ts packages/db/test/isolation-behaviour.test.ts`
Expected: FAIL. The catalog test fails on row-level security not being enabled; the behaviour tests fail because the roles have no rights or see every row.

- [ ] **Step 5: Write the migration**

`packages/db/migrations/0004_rls_grants.sql`:
```sql
-- Up Migration
-- Row-level security on every table that carries brand_id, the same policy on each.
do $$
declare t text;
begin
  for t in
    select table_name from information_schema.columns
     where table_schema = 'app' and column_name = 'brand_id' order by 1
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format(
      'create policy brand_isolation on app.%I using (brand_id = current_setting(''app.brand_id'', true)::uuid) with check (brand_id = current_setting(''app.brand_id'', true)::uuid)',
      t);
  end loop;
end $$;

-- app.brand is scoped by its own id.
alter table app.brand enable row level security;
alter table app.brand force row level security;
create policy brand_isolation on app.brand
  using (id = current_setting('app.brand_id', true)::uuid)
  with check (id = current_setting('app.brand_id', true)::uuid);

-- Grants. Run-time roles own nothing.
grant select, insert, update, delete on
  app.brand, app.membership, app.invite, app.approval_setting, app.kill_switch,
  app.content_item, app.content_version_state, app.check_result, app.approval_request, app.popup_ack,
  app.outbox_action
  to mkt_app;
-- Insert only: written once, never changed.
grant select, insert on
  app.content_version, app.content_version_state_change, app.asset, app.approval, app.approval_invalidation
  to mkt_app;
grant select on all tables in schema app to mkt_readonly;

-- Down Migration
alter table app.brand disable row level security;
drop policy brand_isolation on app.brand;
do $$
declare t text;
begin
  for t in select table_name from information_schema.columns where table_schema = 'app' and column_name = 'brand_id'
  loop
    execute format('drop policy brand_isolation on app.%I', t);
    execute format('alter table app.%I no force row level security', t);
    execute format('alter table app.%I disable row level security', t);
  end loop;
end $$;
revoke all on all tables in schema app from mkt_app, mkt_readonly;
```
Platform-owner access across brands is added as named functions in Task 6; no run-time role is given a direct policy bypass.

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run packages/db`
Expected: PASS for all files in the package. If the brand-table test fails because `app.brand` also needs to be created by the application role (an insert of a new brand by the owner), do not widen the policy; Task 6 adds the function that creates a brand.

- [ ] **Step 7: Run every check and commit**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run check:pins`
```
git add packages/db
git commit -m "feat(db): forced row-level security, grants and tenant isolation tests"
```

---

### Task 5: `withBrand` and the rule that business queries go through it (acceptance test 7)

**Files:**
- Create: `packages/db/src/with-brand.ts`; modify `packages/db/src/index.ts`, `eslint.config.mjs`
- Test: `packages/db/test/with-brand.test.ts`, `packages/db/test/lint-rule.test.ts`

**Interfaces:**
- Consumes: the harness and tables above
- Produces: `withBrand<T>(pool: pg.Pool, brandId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T>` from `@mkt/db`; an ESLint restriction that forbids importing `pg`, `kysely` or `pg-boss` outside `packages/db`, `packages/queue*`, test folders and the checks packages.

- [ ] **Step 1: Write the failing tests**

`packages/db/test/with-brand.test.ts`:
```ts
import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrand } from '../src/with-brand.ts'
import { createTestDatabase, seedBrand, type TestDatabase } from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

describe('withBrand', () => {
  let db: TestDatabase
  let pool: pg.Pool
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    await seedBrand(db, A, 'brand-a')
    await seedBrand(db, B, 'brand-b')
    // One connection only, so a leaked setting would be seen by the next call.
    pool = new pg.Pool({ connectionString: db.urlFor('app'), max: 1 })
  })
  afterAll(async () => {
    await pool.end()
    await db.drop()
  })

  it('shows the work only the brand it was given', async () => {
    const rows = await withBrand(pool, A, (c) => c.query('select distinct brand_id from app.content_item'))
    expect(rows.rows.map((r) => r.brand_id)).toEqual([A])
  })

  it('does not leave the brand set for the next user of the same connection', async () => {
    await withBrand(pool, A, (c) => c.query('select 1'))
    const after = await pool.query("select current_setting('app.brand_id', true) as brand")
    expect(after.rows[0].brand === null || after.rows[0].brand === '').toBe(true)
    const none = await pool.query('select count(*)::int as n from app.content_item')
    expect(none.rows[0].n).toBe(0)
  })

  it('rolls back everything when the work throws, and still releases the connection', async () => {
    await expect(
      withBrand(pool, A, async (c) => {
        await c.query("insert into app.content_item (brand_id, kind) values ($1, 'summary')", [A])
        throw new Error('stop')
      }),
    ).rejects.toThrow('stop')
    const count = await withBrand(pool, A, (c) => c.query('select count(*)::int as n from app.content_item'))
    expect(count.rows[0].n).toBe(1)
  })

  it('rejects a brand ID that is not a UUID before any query is sent', async () => {
    await expect(withBrand(pool, "x'; drop table app.brand; --", async () => 1)).rejects.toThrow('not a valid brand ID')
  })
})
```

`packages/db/test/lint-rule.test.ts`:
```ts
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const root = new URL('../../..', import.meta.url).pathname

async function messages(filePath: string, code: string) {
  const eslint = new ESLint({ cwd: root })
  const [result] = await eslint.lintText(code, { filePath: `${root}${filePath}` })
  return result!.messages.map((m) => m.ruleId)
}

describe('business queries must go through withBrand (acceptance test 7)', () => {
  it('rejects importing pg in application code', async () => {
    expect(await messages('apps/core/src/x.ts', "import pg from 'pg'\nexport const p = pg\n")).toContain('no-restricted-imports')
  })

  it('rejects importing kysely and pg-boss in application code', async () => {
    expect(await messages('apps/worker/src/x.ts', "import { Kysely } from 'kysely'\nexport const k = Kysely\n")).toContain('no-restricted-imports')
    expect(await messages('apps/worker/src/y.ts', "import { PgBoss } from 'pg-boss'\nexport const q = PgBoss\n")).toContain('no-restricted-imports')
  })

  it('allows the same imports inside the db package', async () => {
    expect(await messages('packages/db/src/x.ts', "import pg from 'pg'\nexport const p = pg\n")).not.toContain('no-restricted-imports')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/db/test/with-brand.test.ts packages/db/test/lint-rule.test.ts`
Expected: FAIL, cannot find `../src/with-brand.ts`; the lint test fails because no rule restricts the import.

- [ ] **Step 3: Write `withBrand`**

`packages/db/src/with-brand.ts`:
```ts
import type pg from 'pg'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Runs work for one brand inside one transaction. The brand is set for that transaction only,
// so a pooled connection never carries it to the next user.
export async function withBrand<T>(
  pool: pg.Pool,
  brandId: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(brandId)) throw new Error('not a valid brand ID')
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('app.brand_id', $1, true)", [brandId])
    const result = await work(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
```
Add `export { withBrand } from './with-brand.ts'` to `packages/db/src/index.ts`.

- [ ] **Step 4: Add the restriction to the ESLint configuration**

In `eslint.config.mjs`, add before `prettier,`:
```js
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    ignores: [
      'packages/db/**',
      'packages/queue/**',
      'packages/queue-contract/**',
      'packages/test-support/**',
      'packages/stack-check/**',
      '**/test/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['pg', 'kysely', 'pg-boss'].map((name) => ({
            name,
            message: 'Business data is reached only through @mkt/db (withBrand).',
          })),
        },
      ],
    },
  },
```
Add `eslint` itself as a dependency of `packages/db`: `"devDependencies": { "eslint": "10.10.0" }`, then run `npm install`.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run packages/db`
Expected: PASS. Then `npm run lint`; expected: passes (the restriction applies to no existing file).

- [ ] **Step 6: Commit**

```
git add packages/db eslint.config.mjs package-lock.json
git commit -m "feat(db): withBrand helper and a lint rule that keeps business queries behind it"
```

---

### Task 6: Cross-brand access through named functions only

**Files:**
- Create: `packages/db/migrations/0005_functions.sql`
- Test: `packages/db/test/functions.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 4
- Produces: `app.create_brand(p_name text, p_slug text) returns uuid` (executable by `mkt_app`); `app.is_platform_owner(p_user uuid) returns boolean` (`mkt_app`); `app.memberships_for_user(p_user uuid) returns table(brand_id uuid, role app.membership_role)` (`mkt_app`); `app.list_all_brands() returns table(id uuid, name text, slug text, status app.brand_status)` (`mkt_owner_view` only). All are `security definer`, owned by `mkt_definer`, with a fixed search path.

- [ ] **Step 1: Write the failing test**

`packages/db/test/functions.test.ts`:
```ts
import { requireDatabase } from '@mkt/test-support'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, seedBrand, type RoleName, type TestDatabase } from '../src/testing.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

async function query(db: TestDatabase, role: RoleName, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: db.urlFor(role) })
  await client.connect()
  try {
    return await client.query(sql, params)
  } finally {
    await client.end()
  }
}

describe('named functions for access that crosses brands', () => {
  let db: TestDatabase
  beforeAll(async () => {
    await requireDatabase()
    db = await createTestDatabase()
    await seedBrand(db, A, 'brand-a')
    await seedBrand(db, B, 'brand-b')
  })
  afterAll(async () => db.drop())

  it('lets the owner-view role list every brand, and no other role', async () => {
    const all = await query(db, 'owner_view', 'select slug from app.list_all_brands() order by 1')
    expect(all.rows.map((r) => r.slug)).toEqual(['brand-a', 'brand-b'])
    for (const role of ['app', 'queue', 'readonly', 'audit_writer'] as const) {
      await expect(query(db, role, 'select * from app.list_all_brands()'), role).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('finds a user\'s memberships across brands with no brand set', async () => {
    const user = await db.admin.query("select user_id from app.membership m join app.brand b on b.id = m.brand_id where b.slug = 'brand-a'")
    // the admin pool is the cluster superuser, which bypasses row-level security, only to read the seeded user
    const found = await query(db, 'app', 'select brand_id, role from app.memberships_for_user($1)', [user.rows[0].user_id])
    expect(found.rows).toEqual([{ brand_id: A, role: 'approver' }])
  })

  it('answers whether a user is a platform owner, false for an unknown user', async () => {
    const r = await query(db, 'app', 'select app.is_platform_owner(gen_random_uuid()) as owner')
    expect(r.rows[0].owner).toBe(false)
  })

  it('creates a brand with its default approval setting, and refuses a bad slug', async () => {
    const created = await query(db, 'app', "select app.create_brand('Test', 'test-brand') as id")
    const id = created.rows[0].id as string
    const client = new pg.Client({ connectionString: db.urlFor('app') })
    await client.connect()
    try {
      await client.query('begin')
      await client.query("select set_config('app.brand_id', $1, true)", [id])
      const setting = await client.query('select reminder_count from app.approval_setting')
      expect(setting.rows).toEqual([{ reminder_count: 3 }])
      await client.query('rollback')
    } finally {
      await client.end()
    }
    await expect(query(db, 'app', "select app.create_brand('Bad', 'Bad Slug')")).rejects.toMatchObject({ code: '23514' })
  })

  it('gives the application role no way to read another brand through the functions', async () => {
    const r = await query(db, 'app', 'select count(*)::int as n from app.memberships_for_user(gen_random_uuid())')
    expect(r.rows[0].n).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/db/test/functions.test.ts`
Expected: FAIL, `function app.list_all_brands() does not exist`.

- [ ] **Step 3: Write the migration**

`packages/db/migrations/0005_functions.sql`:
```sql
-- Up Migration
-- Policies that let only the function owner see across brands. No run-time role has these.
create policy definer_read_brand on app.brand for select to mkt_definer using (true);
create policy definer_insert_brand on app.brand for insert to mkt_definer with check (true);
create policy definer_read_membership on app.membership for select to mkt_definer using (true);
create policy definer_insert_setting on app.approval_setting for insert to mkt_definer with check (true);
grant select, insert on app.brand to mkt_definer;
grant select on app.membership to mkt_definer;
grant select on app.platform_owner to mkt_definer;
grant insert on app.approval_setting to mkt_definer;

create function app.list_all_brands()
returns table (id uuid, name text, slug text, status app.brand_status)
language sql security definer set search_path = pg_catalog, app
as $$ select id, name, slug, status from app.brand order by slug $$;
alter function app.list_all_brands() owner to mkt_definer;
revoke all on function app.list_all_brands() from public;
grant execute on function app.list_all_brands() to mkt_owner_view;

create function app.is_platform_owner(p_user uuid)
returns boolean
language sql security definer set search_path = pg_catalog, app
as $$ select exists (select 1 from app.platform_owner where user_id = p_user) $$;
alter function app.is_platform_owner(uuid) owner to mkt_definer;
revoke all on function app.is_platform_owner(uuid) from public;
grant execute on function app.is_platform_owner(uuid) to mkt_app;

create function app.memberships_for_user(p_user uuid)
returns table (brand_id uuid, role app.membership_role)
language sql security definer set search_path = pg_catalog, app
as $$ select m.brand_id, m.role from app.membership m where m.user_id = p_user $$;
alter function app.memberships_for_user(uuid) owner to mkt_definer;
revoke all on function app.memberships_for_user(uuid) from public;
grant execute on function app.memberships_for_user(uuid) to mkt_app;

create function app.create_brand(p_name text, p_slug text)
returns uuid
language plpgsql security definer set search_path = pg_catalog, app
as $$
declare new_id uuid := gen_random_uuid();
begin
  perform set_config('app.brand_id', new_id::text, true);
  insert into app.brand (id, name, slug) values (new_id, p_name, p_slug);
  insert into app.approval_setting (brand_id) values (new_id);
  return new_id;
end $$;
alter function app.create_brand(text, text) owner to mkt_definer;
revoke all on function app.create_brand(text, text) from public;
grant execute on function app.create_brand(text, text) to mkt_app;

-- Down Migration
drop function app.create_brand(text, text);
drop function app.memberships_for_user(uuid);
drop function app.is_platform_owner(uuid);
drop function app.list_all_brands();
drop policy definer_insert_setting on app.approval_setting;
drop policy definer_read_membership on app.membership;
drop policy definer_insert_brand on app.brand;
drop policy definer_read_brand on app.brand;
```
`create_brand` leaves the brand set for the rest of the calling transaction, which is the intended behaviour: the caller creates the brand and continues inside it.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/db`
Expected: PASS for the whole package. If the function owner cannot be changed by the migration role, grant it `mkt_definer` membership with `grant mkt_definer to mkt_migration` and record a ruling.

- [ ] **Step 5: Commit**

```
git add packages/db
git commit -m "feat(db): named functions for the access that crosses brands"
```

---

### Task 7: Run everything on the server and record the results

**Files:**
- Modify: `docs/progress.md`, `package.json` (nothing new), `.github/workflows/ci.yml` (no change; the existing service database and `npm run verify` already run the new tests)
- Create: none

**Interfaces:**
- Consumes: Tasks 1 to 6
- Produces: the milestone record

- [ ] **Step 1: Run the full suite twice on the server**

Run (twice, from the laptop, after an `rsync`):
```
ssh root@<dev-server> '/opt/mkt-dev/run.sh "npm ci && npm run verify"'
```
Expected both times: every step passes. A second run proves the tests leave nothing behind (each uses its own database).

- [ ] **Step 2: Confirm no test database is left behind**

Run: `ssh root@<dev-server> "docker exec mkt-dev-postgres-1 psql -U mkt -d postgres -Atc \"select count(*) from pg_database where datname like 'mkt_t_%'\""`
Expected: `0`.

- [ ] **Step 3: Update the progress file**

Append to `docs/progress.md` a section "Phase 1, milestone 2a: Database and isolation" with: date, the commit, the tests proven (2, 3, 4 and 7 in full; 5 for role rights, the queue-row-content half waits for milestone 4), and findings, including each ruling made. State plainly that tests 1 and 6 are not yet proven and why.

- [ ] **Step 4: Commit, push and confirm the checks pass**

```
git add docs
git commit -m "docs: milestone 2a results"
```
Push with the HTTPS method and confirm the workflow run for the pull request succeeded.

- [ ] **Step 5: Report to the owner**

State what passed, each finding, and anything that differs from this plan.
