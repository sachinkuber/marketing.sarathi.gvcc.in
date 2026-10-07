import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import { createHash, randomBytes } from 'node:crypto'
import { AppError } from '../errors.ts'
import type { Mailer } from '../ports.ts'
import { INVITE_HOURS } from './policy.ts'
import type { Auth } from './options.ts'
import type { Role } from './session.ts'
import { createUserWithPassword, removeAfterFailure } from './users.ts'

export function hashInviteToken(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

export async function createInvite(
  pool: Pool,
  mailer: Mailer,
  input: {
    brandId: string
    email: string
    role: Role
    invitedBy: string
    origin: string
    // Runs inside the same transaction, after the insert. If it throws (for example the audit entry cannot
    // be written) the invite is rolled back and no mail is sent.
    inside?: (client: PoolClient, invite: { id: string }) => Promise<void>
    onMailFailure?: (error: unknown) => void
    // Runs after an invite whose mail failed has been taken back (for example to audit the withdrawal). If it
    // throws, that is reported through onMailFailure and the attempt is still refused with the 502.
    onWithdrawn?: (invite: { id: string }) => Promise<void>
  },
): Promise<{ id: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const email = input.email.trim().toLowerCase()
  const row = await withBrand(pool, input.brandId, async (client) => {
    const result = await client.query(
      `insert into app.invite (brand_id, email, role, token_hash, expires_at, invited_by)
       values ($1, $2, $3, $4, now() + make_interval(hours => $5), $6)
       returning id, expires_at`,
      [input.brandId, email, input.role, hashInviteToken(token), INVITE_HOURS, input.invitedBy],
    )
    const created = result.rows[0] as { id: string; expires_at: Date }
    await input.inside?.(client, { id: created.id })
    return created
  })
  try {
    await mailer.send({
      to: email,
      subject: 'You have been invited',
      text: `You have been invited. Open this link to set a password:\n${input.origin}/accept-invite?token=${token}\nThe link works once and expires in ${INVITE_HOURS} hours.`,
    })
  } catch (error) {
    // An invite nobody was told about is worse than none: take it back, and tell the person who asked.
    input.onMailFailure?.(error)
    try {
      await withBrand(pool, input.brandId, (client) =>
        client.query('delete from app.invite where id = $1', [row.id]),
      )
    } catch {
      // The invite is still there and nobody was told about it: name it so the log shows what to remove.
      throw new Error(`invite ${row.id} left behind after the invite email failed`, { cause: error })
    }
    try {
      await input.onWithdrawn?.({ id: row.id })
    } catch (reportError) {
      input.onMailFailure?.(
        new Error(`invite ${row.id} was taken back, but that could not be recorded`, { cause: reportError }),
      )
    }
    throw new AppError(502, 'mail_not_sent', 'The invite email could not be sent, so no invite was made.')
  }
  return { id: row.id, expiresAt: row.expires_at }
}

const INVALID = () =>
  new AppError(410, 'invite_invalid', 'This invite is no longer valid. Ask for a new one.')

export async function peekInvite(
  pool: Pool,
  token: string,
): Promise<{ email: string; role: Role; brandName: string } | null> {
  const result = await pool.query('select email, role, brand_name from app.peek_invite($1)', [
    hashInviteToken(token),
  ])
  const row = result.rows[0]
  return row ? { email: row.email, role: row.role, brandName: row.brand_name } : null
}

export async function lookupInvite(pool: Pool, token: string) {
  const found = await peekInvite(pool, token)
  if (!found) throw INVALID()
  return found
}

// Order: check the invite, make the account, then redeem. If redeeming fails for any reason, the account
// just made is removed, so a refused accept never leaves a user behind; if even that fails, the error
// names the user (a 500, logged with the id).
export async function acceptInvite(
  auth: Auth,
  pool: Pool,
  input: { token: string; name: string; password: string },
): Promise<{ userId: string; brandId: string }> {
  const invite = await peekInvite(pool, input.token)
  if (!invite) throw INVALID()
  const { id: userId } = await createUserWithPassword(auth, {
    email: invite.email,
    name: input.name,
    password: input.password,
  })
  try {
    const redeemed = await pool.query('select brand_id from app.redeem_invite($1, $2)', [
      hashInviteToken(input.token),
      userId,
    ])
    return { userId, brandId: redeemed.rows[0].brand_id as string }
  } catch (error) {
    await removeAfterFailure(
      auth,
      userId,
      error,
      'invite accept: user {id} left behind after a failed redeem',
    )
    if ((error as { code?: string }).code === 'MKT01') throw INVALID()
    throw error
  }
}
