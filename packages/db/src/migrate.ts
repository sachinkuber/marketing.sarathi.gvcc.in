import { runner } from 'node-pg-migrate'
import { join } from 'node:path'

const migrationsDir = join(import.meta.dirname, '..', 'migrations')

// Applies the migrations that have not run yet and returns their names (none when the database is current).
export async function migrate(databaseUrl: string): Promise<string[]> {
  const applied = await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    migrationsSchema: 'public',
    createSchema: false,
    log: () => undefined,
  })
  return applied.map((migration) => migration.name)
}
