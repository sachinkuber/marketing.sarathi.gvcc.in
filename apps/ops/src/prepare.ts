import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { migrate } from '@mkt/db'
import { QUEUE_SCHEMA, installQueue, updateQueue } from '@mkt/queue'
import { ROLES, checkRolePasswords, setRolePasswords, type RolePasswords } from './set-role-passwords.ts'

export interface PrepareOptions {
  adminUrl: string
  rolePasswords: RolePasswords
}

// Every deployment, before the core and the worker start (plan: migrations, then the queue, then the
// services): run the migrations that have not run, give the run-time roles their passwords, create missing
// queues and bring existing ones to the settings in @mkt/queue. Safe to run any number of times.
export async function prepare(opts: PrepareOptions): Promise<{ migrated: string[]; queues: string[] }> {
  checkRolePasswords(opts.rolePasswords)
  await withClient(opts.adminUrl, ensureMigrationRole)
  const migrated = await migrate(opts.adminUrl)
  await setRolePasswords(opts.adminUrl, opts.rolePasswords)
  await installQueue(opts.adminUrl)
  await updateQueue(opts.adminUrl)
  const queues = await withClient(opts.adminUrl, async (client) => {
    const { rows } = await client.query<{ name: string }>(
      `select name from ${QUEUE_SCHEMA}.queue order by name collate "C"`,
    )
    // The library's own internal queues (__pgboss__*) are not ours to report.
    return rows.map((row) => row.name).filter((name) => !name.startsWith('__pgboss__'))
  })
  return { migrated, queues }
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

// Migration 0005 lets the migration role act as the function owner. On a new server only the superuser
// exists, so the role is created here, without a login, the way 0001 creates the run-time roles.
async function ensureMigrationRole(client: pg.Client): Promise<void> {
  const { rowCount } = await client.query("select 1 from pg_roles where rolname = 'mkt_migration'")
  if (rowCount === 0) await client.query('create role mkt_migration nologin')
}

const PASSWORD_VARIABLES: Record<(typeof ROLES)[number], string> = {
  mkt_app: 'MKT_APP_PASSWORD',
  mkt_audit_writer: 'MKT_AUDIT_WRITER_PASSWORD',
  mkt_queue: 'MKT_QUEUE_PASSWORD',
  mkt_owner_view: 'MKT_OWNER_VIEW_PASSWORD',
}

// The values come from the environment (postgres.env and roles.env), never from the command line.
export function optionsFromEnv(env: Record<string, string | undefined>): PrepareOptions {
  const names = ['ADMIN_DATABASE_URL', ...Object.values(PASSWORD_VARIABLES)]
  const missing = names.filter((name) => !env[name])
  if (missing.length > 0) throw new Error(`Missing environment variables: ${missing.join(', ')}.`)
  const rolePasswords = Object.fromEntries(
    ROLES.map((role) => [role, env[PASSWORD_VARIABLES[role]] ?? '']),
  ) as RolePasswords
  return { adminUrl: env.ADMIN_DATABASE_URL!, rolePasswords }
}

// `npm run deploy:prepare --workspace @mkt/ops`, or `prepare` in the ops image. (Not an npm script named
// `prepare`: npm runs a workspace's `prepare` script on every `npm install` and `npm ci`.)
export async function prepareFromEnv(env: Record<string, string | undefined>): Promise<void> {
  const result = await prepare(optionsFromEnv(env))
  const line = { event: 'prepared', migrated: result.migrated, queues: result.queues }
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

// A failure is reported by its message when it is ours (it names variables and roles, never a value), and
// by its name and code only when it comes from the database or the network.
export function failureLine(error: unknown): string {
  const e = error as { message?: string; code?: string; name?: string }
  const detail = e.code ? `${e.name ?? 'Error'} ${e.code}` : (e.message ?? 'unknown error')
  return `${JSON.stringify({ event: 'prepare_failed', error: detail })}\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  prepareFromEnv(process.env).catch((error: unknown) => {
    process.stderr.write(failureLine(error))
    process.exit(1)
  })
}
