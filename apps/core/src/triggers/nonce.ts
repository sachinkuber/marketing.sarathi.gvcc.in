import type { Pool } from '@mkt/db'
import { WINDOW_SECONDS } from './signature.ts'

// How long a nonce is kept. A signed request stays acceptable for up to 2 x WINDOW_SECONDS (its timestamp may
// be a window ahead of our clock when first used and a window behind when replayed), plus up to a second lost
// to flooring the clock. Retention must outlast that. The specification says ten minutes; this is eleven, a
// deliberate and safe departure (a longer retention only refuses more): the extra minute covers the floor, the
// time between the timestamp check and the database write, and ordinary clock skew between this service and
// the database (the timestamp check uses the service clock, retention uses the database clock).
export const KEEP_SECONDS = 2 * WINDOW_SECONDS + 60

// Records a nonce. False means it was already there: a replay. Old nonces are removed in the same statement, so
// one database timestamp serves both the removal and the new row, and a fresh nonce is never removed.
export async function useNonce(pool: Pool, nonceHex: string): Promise<boolean> {
  const result = await pool.query(
    `with gone as (delete from app.trigger_nonce where received_at < now() - make_interval(secs => $2))
     insert into app.trigger_nonce (nonce) values (decode($1, 'hex')) on conflict do nothing returning nonce`,
    [nonceHex, KEEP_SECONDS],
  )
  return result.rowCount === 1
}

export async function cleanNonces(pool: Pool): Promise<number> {
  const result = await pool.query(
    'delete from app.trigger_nonce where received_at < now() - make_interval(secs => $1)',
    [KEEP_SECONDS],
  )
  return result.rowCount ?? 0
}
