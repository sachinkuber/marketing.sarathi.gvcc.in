import { createHash } from 'node:crypto'
import type pg from 'pg'

// The database half of the tenant-isolation acceptance tests (2 to 5), as functions: the test suites
// (packages/db/test/isolation-*.test.ts) run them on a fresh test database, and the restore drill
// (apps/ops/src/restore-check.ts) runs them on a restored copy. Each probe throws an Error naming the role,
// table or constraint that failed, never a row's content; it returns quietly when the rule holds.

export type RoleName = 'app' | 'queue' | 'audit_writer' | 'owner_view' | 'readonly'
export const RUNTIME_ROLES: RoleName[] = ['app', 'queue', 'audit_writer', 'owner_view', 'readonly']

// Tables seedProbeBrand fills. The catalog probes prove the same policy exists on all the others.
export const SEEDED = [
  'membership',
  'invite',
  'content_item',
  'content_version',
  'kill_switch',
  'suggestion',
  'verified_fact',
  'safety_rule',
  'brand_document',
  'research_source',
  'profile_item',
] as const

// Runs `fn` as the run-time role `role`, with the session's brand set (or none), and undoes whatever it did.
// The tests connect as the role itself; the restore drill switches to it inside one transaction it rolls back.
export type AsRole = <T>(
  role: RoleName,
  brand: string | null,
  fn: (client: pg.ClientBase) => Promise<T>,
) => Promise<T>

export type Queryable = Pick<pg.ClientBase, 'query'>

// A payload and hash that satisfy the content_version triggers, for a version row whose content does not
// matter. The payload names the row's own brand and item, as the trigger requires.
export function versionRow(brandId: string, itemId: string): { payload: string; hash: string } {
  const payload = JSON.stringify({
    brand_id: brandId,
    content_item_id: itemId,
    kind: 'summary',
    schema: 'content-version/1',
  })
  return { payload, hash: 'sha256:' + createHash('sha256').update(payload, 'utf8').digest('hex') }
}

// A brand and one row in each SEEDED table, on a client already in a transaction, as a role allowed to write
// them. Leaves the transaction's brand setting on `id`.
export async function seedProbeBrand(client: Queryable, id: string, slug: string): Promise<void> {
  await client.query("select set_config('app.brand_id', $1, true)", [id])
  await client.query('insert into app.brand (id, name, slug) values ($1, $2, $2)', [id, slug])
  const user = await client.query(
    `insert into auth."user" (name, email, "emailVerified") values ($1, $2, true) returning id`,
    [slug, `${slug}@example.test`],
  )
  const userId = user.rows[0].id as string
  await client.query("insert into app.membership (brand_id, user_id, role) values ($1, $2, 'approver')", [
    id,
    userId,
  ])
  await client.query(
    "insert into app.invite (brand_id, email, role, token_hash, expires_at, invited_by) values ($1, $2, 'viewer', gen_random_bytes(32), now() + interval '72 hours', $3)",
    [id, `${slug}@example.test`, userId],
  )
  const item = await client.query(
    "insert into app.content_item (brand_id, kind) values ($1, 'summary') returning id",
    [id],
  )
  const itemId = item.rows[0].id as string
  const v = versionRow(id, itemId)
  await client.query(
    "insert into app.content_version (brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by_kind) values ($1, $2, 1, $3, $4, 'cv1', 'system')",
    [id, itemId, v.payload, v.hash],
  )
  await client.query(
    "insert into app.kill_switch (brand_id, scope, active, set_by) values ($1, 'brand', false, gen_random_uuid())",
    [id],
  )
  await client.query(
    "insert into app.suggestion (brand_id, step, key, proposed, why, confidence) values ($1, 'profile', 'tagline', '\"x\"'::jsonb, 'seeded', 'found')",
    [id],
  )
  const source = await client.query(
    "insert into app.research_source (brand_id, kind, result, extract) values ($1, 'owner_statement', 'stated', 'seeded') returning id",
    [id],
  )
  await client.query(
    "insert into app.brand_document (brand_id, file_name, media_type, bytes, size_bytes, sha256, uploaded_by) values ($1, 'seeded.pdf', 'application/pdf', '\\x01020304', 4, 'sha256:seed', $2)",
    [id, userId],
  )
  await client.query(
    "insert into app.profile_item (brand_id, key, value, status, source_ids) values ($1, 'tagline', '\"x\"'::jsonb, 'found', $2)",
    [id, [source.rows[0].id as string]],
  )
  await client.query(
    "insert into app.verified_fact (brand_id, statement, fact_hash, source_ids, confirmed_by, review_date) values ($1, 'seeded', 'sha256:seed', $2, $3, current_date + 365)",
    [id, [source.rows[0].id as string], userId],
  )
  await client.query(
    "insert into app.safety_rule (brand_id, kind, text, why, confirmed_by) values ($1, 'forbidden_word', 'seeded', 'seeded', $2)",
    [id, userId],
  )
}

function fail(message: string): never {
  throw new Error(message)
}

// The SQLSTATE a statement fails with, or null when it succeeds.
async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? 'no_code'
  }
}

async function expectRefused(what: string, code: string, run: () => Promise<unknown>): Promise<void> {
  const got = await refusal(run)
  if (got !== code) fail(`${what}: expected refusal ${code}, got ${got ?? 'success'}`)
}

// ---- Test 2: a role sees only its own brand's rows; with no brand set, none.

export async function seesOnlyOwnBrand(
  as: AsRole,
  role: 'app' | 'readonly',
  brand: string,
  table: string,
): Promise<void> {
  const seen = await as(role, brand, (c) => c.query(`select distinct brand_id from app.${table}`))
  const others = seen.rows.filter((r) => r.brand_id !== brand).length
  if (others > 0) fail(`${role} in one brand sees ${others} other brand(s) in ${table}`)
}

export async function seesOwnBrandRows(
  as: AsRole,
  role: 'app' | 'readonly',
  brand: string,
  table: string,
): Promise<void> {
  const seen = await as(role, brand, (c) => c.query(`select distinct brand_id from app.${table}`))
  const brands = seen.rows.map((r) => r.brand_id as string)
  if (brands.length !== 1 || brands[0] !== brand)
    fail(`${role} does not see exactly its own brand in ${table}`)
}

export async function seesNothingWithoutBrand(as: AsRole, table: string): Promise<void> {
  for (const role of ['app', 'readonly'] as const) {
    const none = await as(role, null, (c) => c.query(`select count(*)::int as n from app.${table}`))
    if (none.rows[0].n !== 0) fail(`${role} with no brand set sees rows in ${table}`)
  }
}

export async function brandTableShowsOnlyOwn(as: AsRole, brand: string): Promise<void> {
  const r = await as('app', brand, (c) => c.query('select id from app.brand'))
  if (r.rows.length !== 1 || r.rows[0].id !== brand) fail('the brand table shows a session other brands')
}

// ---- Test 5 (database part): the queue, audit-writer and owner-view roles cannot read business tables.

export async function serviceRolesReadNoBusinessTable(as: AsRole, brand: string): Promise<void> {
  for (const role of ['queue', 'audit_writer', 'owner_view'] as const) {
    for (const table of [...SEEDED, 'brand', 'approval_setting']) {
      await expectRefused(`${role} reading ${table}`, '42501', () =>
        as(role, brand, (c) => c.query(`select 1 from app.${table} limit 1`)),
      )
    }
  }
}

// ---- Test 3: writes carrying or moving to another brand are refused, as is any write with no brand set.

export async function refusesInsertForOtherBrand(as: AsRole, brand: string, other: string): Promise<void> {
  await expectRefused('insert into membership for another brand', '42501', () =>
    as('app', brand, (c) =>
      c.query(
        "insert into app.membership (brand_id, user_id, role) values ($1, gen_random_uuid(), 'viewer')",
        [other],
      ),
    ),
  )
  await expectRefused('insert into content_item for another brand', '42501', () =>
    as('app', brand, (c) =>
      c.query("insert into app.content_item (brand_id, kind) values ($1, 'summary')", [other]),
    ),
  )
}

export async function refusesUpdateToOtherBrand(as: AsRole, brand: string, other: string): Promise<void> {
  await expectRefused('update moving content_item to another brand', '42501', () =>
    as('app', brand, (c) =>
      c.query('update app.content_item set brand_id = $1 where brand_id = $2', [other, brand]),
    ),
  )
}

export async function refusesInsertWithoutBrand(as: AsRole, brand: string): Promise<void> {
  await expectRefused('insert with no brand set', '42501', () =>
    as('app', null, (c) =>
      c.query("insert into app.content_item (brand_id, kind) values ($1, 'summary')", [brand]),
    ),
  )
}

// ---- Test 4: a row in one brand cannot reference a parent row in another.

export async function refusesCrossBrandParent(as: AsRole, brand: string, other: string): Promise<void> {
  const parent = await as('app', other, (c) => c.query('select id from app.content_item limit 1'))
  const parentId = parent.rows[0]?.id as string | undefined
  if (!parentId) fail('the other brand has no content_item to point at')
  const v = versionRow(brand, parentId)
  await expectRefused('content_version pointing at another brand’s item', '23503', () =>
    as('app', brand, (c) =>
      c.query(
        "insert into app.content_version (brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by_kind) values ($1, $2, 99, $3, $4, 'cv1', 'system')",
        [brand, parentId, v.payload, v.hash],
      ),
    ),
  )
}

export async function appRoleCannotDisableSecurity(as: AsRole, brand: string): Promise<void> {
  await expectRefused('the application role disabling row-level security', '42501', () =>
    as('app', brand, (c) => c.query('alter table app.membership disable row level security')),
  )
}

// ---- The catalog (tests 3 and 4 for every brand-scoped table), read as a superuser or the tables' owner.

const POLICY = "(brand_id = (NULLIF(current_setting('app.brand_id'::text, true), ''::text))::uuid)"

export async function brandScopedTables(db: Queryable): Promise<string[]> {
  const r = await db.query(
    "select table_name from information_schema.columns where table_schema = 'app' and column_name = 'brand_id' order by 1",
  )
  return r.rows.map((x) => x.table_name as string)
}

export async function noPublicFunctions(db: Queryable): Promise<void> {
  const r = await db.query(
    `select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('app', 'audit') and p.prorettype <> 'trigger'::regtype
        and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))`,
  )
  if (r.rows.length > 0) fail(`functions executable by PUBLIC: ${r.rows.map((x) => x.f).join(', ')}`)
}

export function scopedTablesFound(scoped: string[]): void {
  if (scoped.length < 21) fail(`only ${scoped.length} brand-scoped tables found`)
  if (!scoped.includes('content_version')) fail('content_version is not brand-scoped')
  if (scoped.includes('brand')) fail('the brand table itself has a brand_id')
}

export async function rowSecurityForced(db: Queryable, scoped: string[]): Promise<void> {
  const r = await db.query(
    "select relname, relrowsecurity, relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r' and c.relname = any($1)",
    [scoped],
  )
  if (r.rowCount !== scoped.length) fail('not every brand-scoped table is a plain table in app')
  for (const row of r.rows) {
    if (!row.relrowsecurity || !row.relforcerowsecurity)
      fail(`row-level security not forced on ${row.relname}`)
  }
}

export async function brandPolicies(db: Queryable, scoped: string[]): Promise<void> {
  const r = await db.query(
    "select tablename, policyname, qual, with_check, cmd from pg_policies where schemaname = 'app' and tablename = any($1) and policyname = 'brand_isolation'",
    [scoped],
  )
  if (r.rowCount !== scoped.length) fail('not every brand-scoped table has one brand_isolation policy')
  for (const row of r.rows) {
    if (row.cmd !== 'ALL' || row.qual !== POLICY || row.with_check !== POLICY) {
      fail(`the brand_isolation policy on ${row.tablename} is not the standard one`)
    }
  }
}

export async function brandIdUniqueKeys(db: Queryable, scoped: string[]): Promise<void> {
  const withId = await db.query(
    "select table_name from information_schema.columns where table_schema = 'app' and column_name = 'id' and table_name = any($1)",
    [scoped],
  )
  if ((withId.rowCount ?? 0) < 17) fail(`only ${withId.rowCount} brand-scoped tables with an id`)
  for (const { table_name } of withId.rows) {
    const r = await db.query(
      `select 1 from pg_constraint c where c.conrelid = ('app.' || $1)::regclass and c.contype = 'u'
         and (select array_agg(a.attname::text order by a.attname) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) = array['brand_id','id']`,
      [table_name],
    )
    if (r.rowCount !== 1) fail(`${table_name} has no unique key on (brand_id, id)`)
  }
}

export async function brandIdInForeignKeys(db: Queryable, scoped: string[]): Promise<void> {
  const r = await db.query(
    `select c.conname, c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
            array(select a.attname::text from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) as child_cols,
            array(select a.attname::text from pg_attribute a where a.attrelid = c.confrelid and a.attnum = any(c.confkey)) as parent_cols
       from pg_constraint c
      where c.contype = 'f' and c.connamespace = 'app'::regnamespace`,
  )
  const names = new Set(scoped.map((t) => `app.${t}`))
  const between = r.rows.filter((x) => names.has(x.child) && names.has(x.parent))
  if (between.length < 19) fail(`only ${between.length} foreign keys between brand-scoped tables`)
  for (const fk of between) {
    if (!fk.child_cols.includes('brand_id') || !fk.parent_cols.includes('brand_id')) {
      fail(`foreign key ${fk.conname} does not carry brand_id on both sides`)
    }
  }
}
