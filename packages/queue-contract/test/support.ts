import { databaseUrl } from '@mkt/test-support'
import { PgBoss, type ConstructorOptions } from 'pg-boss'

// A schema of its own, so these tests never touch the product's queue.
export const QUEUE_SCHEMA = 'pgboss_contract'

export async function startQueue(extra: Partial<ConstructorOptions> = {}): Promise<PgBoss> {
  const queue = new PgBoss({
    connectionString: databaseUrl,
    schema: QUEUE_SCHEMA,
    superviseIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
    ...extra,
  })
  queue.on('error', (error) => console.error('queue error:', error))
  await queue.start()
  return queue
}

// Unique per run, so jobs left by an earlier run are never seen.
export function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
