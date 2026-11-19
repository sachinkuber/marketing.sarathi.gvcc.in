import { databaseUrl } from '@mkt/test-support'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { RUNTIME_ROLES, seedProbeBrand, type RoleName } from './isolation-probes.ts'
import { migrate } from './migrate.ts'

// The role names, the version-row helper and the brand seed live with the isolation probes, which the restore
// drill also runs; they are re-exported here for the tests.
export { RUNTIME_ROLES, versionRow, type RoleName } from './isolation-probes.ts'

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
    await seedProbeBrand(client, id, slug)
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

// A definition version for tests that need a run. Not brand-scoped, so it is written as the superuser.
export async function seedDefinition(db: TestDatabase, agent = 'test-agent'): Promise<string> {
  const { rows } = await db.admin.query<{ id: string }>(
    `insert into app.agent_definition_version (agent, version, model, effort, files_hash)
     values ($1, (select coalesce(max(version), 0) + 1 from app.agent_definition_version where agent = $1), 'claude-opus-5-5', 'low', 'test')
     returning id`,
    [agent],
  )
  return rows[0]!.id
}

export async function seedRun(db: TestDatabase, brandId: string, definitionId: string): Promise<string> {
  const { rows } = await db.admin.query<{ id: string }>(
    `insert into app.run (brand_id, agent, definition_version_id, state, started_by_kind)
     values ($1, 'test-agent', $2, 'running', 'system') returning id`,
    [brandId, definitionId],
  )
  return rows[0]!.id
}
