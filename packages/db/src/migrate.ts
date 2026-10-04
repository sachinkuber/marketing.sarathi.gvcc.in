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
