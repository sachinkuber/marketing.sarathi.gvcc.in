import type { Pool } from '@mkt/db'

// A nonce is kept for ten minutes: twice the five-minute window, so a request cannot be replayed while its
// timestamp is still acceptable.
const KEEP = "interval '10 minutes'"

// Records a nonce. False means it was already there: a replay. Old nonces are removed first.
export async function useNonce(pool: Pool, nonceHex: string): Promise<boolean> {
  await pool.query(`delete from app.trigger_nonce where received_at < now() - ${KEEP}`)
  const result = await pool.query(
    "insert into app.trigger_nonce (nonce) values (decode($1, 'hex')) on conflict do nothing returning nonce",
    [nonceHex],
  )
  return result.rowCount === 1
}

export async function cleanNonces(pool: Pool): Promise<number> {
  const result = await pool.query(`delete from app.trigger_nonce where received_at < now() - ${KEEP}`)
  return result.rowCount ?? 0
}
