import pg from 'pg'

export const databaseUrl: string =
  process.env.DATABASE_URL ?? 'postgres://mkt:mkt_dev_only@127.0.0.1:54329/mkt_dev'

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function requireDatabase(url: string = databaseUrl): Promise<void> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 })
  try {
    await client.connect()
    await client.query('select 1')
  } catch {
    throw new Error('The development database is not reachable. Start it with: npm run db:up')
  } finally {
    await client.end().catch(() => undefined)
  }
}
