import { withBrand, type Pool } from '@mkt/db'
import type { Role } from '../auth/session.ts'

export interface Member {
  userId: string
  email: string
  name: string
  role: Role
  twoFactorEnabled: boolean
  since: string
}

export interface PendingInvite {
  id: string
  email: string
  role: Role
  expiresAt: string
  expired: boolean
}

// Row-level security limits the membership and invite rows to the brand set for the transaction. The user's
// own columns come from the sign-in library's table; no hash and no token column is ever selected.
export async function listMembers(
  pool: Pool,
  brandId: string,
): Promise<{ members: Member[]; pendingInvites: PendingInvite[] }> {
  return withBrand(pool, brandId, async (client) => {
    const members = await client.query(
      `select m.user_id, u.email, u.name, m.role, u."twoFactorEnabled" as two_factor_enabled, m.created_at
         from app.membership m join auth."user" u on u.id = m.user_id
        order by u.email`,
    )
    const invites = await client.query(
      `select id, email, role, expires_at, expires_at <= now() as expired
         from app.invite where used_at is null order by created_at`,
    )
    return {
      members: members.rows.map((row) => ({
        userId: row.user_id,
        email: row.email,
        name: row.name,
        role: row.role,
        twoFactorEnabled: Boolean(row.two_factor_enabled),
        since: new Date(row.created_at).toISOString(),
      })),
      pendingInvites: invites.rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        expiresAt: new Date(row.expires_at).toISOString(),
        expired: Boolean(row.expired),
      })),
    }
  })
}
