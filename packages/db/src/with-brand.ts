import type pg from 'pg'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Runs work for one brand inside one transaction. The brand is set for that transaction only,
// so a pooled connection never carries it to the next user.
export async function withBrand<T>(
  pool: pg.Pool,
  brandId: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(brandId)) throw new Error('not a valid brand ID')
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('app.brand_id', $1, true)", [brandId])
    const result = await work(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
