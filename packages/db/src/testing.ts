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

  try {
    await migrate(urlWith(databaseUrl, name, 'mkt_migration', password('migration')))
  } catch (error) {
    // A failed migration must not leave its throw-away database behind.
    const cleanup = new pg.Client({ connectionString: databaseUrl })
    await cleanup.connect()
    try {
      await cleanup.query(`drop database if exists ${name} with (force)`)
    } finally {
      await cleanup.end()
    }
    throw error
  }

  // Give the run-time roles a login. The migration only creates them without one.
  const admin = new pg.Pool({ connectionString: urlWith(databaseUrl, name), max: 2 })
  for (const role of RUNTIME_ROLES) {
    await admin.query(`alter role mkt_${role} login password '${password(role)}'`)
  }

  return {
    name,
    urlFor: (role) => urlWith(databaseUrl, name, `mkt_${role}`, password(role)),
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

// Creates a brand and one row in each of the main brand-scoped tables, as the table owner, with the brand set.
export async function seedBrand(db: TestDatabase, id: string, slug: string): Promise<void> {
  const client = new pg.Client({ connectionString: db.urlFor('migration') })
  await client.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('app.brand_id', $1, true)", [id])
    await client.query('insert into app.brand (id, name, slug) values ($1, $2, $2)', [id, slug])
    await client.query(
      "insert into app.membership (brand_id, user_id, role) values ($1, gen_random_uuid(), 'approver')",
      [id],
    )
    await client.query(
      "insert into app.invite (brand_id, email, role, token_hash, expires_at, invited_by) values ($1, $2, 'viewer', gen_random_bytes(32), now() + interval '72 hours', gen_random_uuid())",
      [id, `${slug}@example.test`],
    )
    const item = await client.query(
      "insert into app.content_item (brand_id, kind) values ($1, 'summary') returning id",
      [id],
    )
    await client.query(
      "insert into app.content_version (brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by_kind) values ($1, $2, 1, '{}', 'sha256:x', 'cv1', 'system')",
      [id, item.rows[0].id],
    )
    await client.query(
      "insert into app.kill_switch (brand_id, scope, active, set_by) values ($1, 'brand', false, gen_random_uuid())",
      [id],
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}
