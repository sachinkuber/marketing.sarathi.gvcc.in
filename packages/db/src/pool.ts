import pg from 'pg'

export interface PoolOptions {
  searchPath?: string
  max?: number
}

// The only place a connection pool is made, so application code never imports pg itself.
export function createPool(connectionString: string, options: PoolOptions = {}): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
  })
}
