import { createPool } from '@mkt/db'
import { createTestDatabase } from '@mkt/db/testing'
import { getMigrations } from 'better-auth/db/migration'
import { MemoryAudit, MemoryMailer } from '../testing.ts'
import { AttemptLimiter } from './limiter.ts'
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
        limiter: new AttemptLimiter({ maxFailures: 5, windowMs: 1, lockMs: 1 }),
      }),
    )
    process.stdout.write(`${await compileMigrations()}\n`)
  } finally {
    await pool.end()
  }
} finally {
  await db.drop()
}
