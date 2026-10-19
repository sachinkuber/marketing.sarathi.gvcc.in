import type { Pool, PoolClient } from '@mkt/db'

// Who is told about what. These return user IDs; the address is looked up at send time (emailOf), so a
// changed address is used and no address is stored in a notification.

// The people with the approver role in the brand. Run inside the brand's session (RLS shows only its rows).
export async function approversOf(client: PoolClient, brandId: string): Promise<string[]> {
  return membersWith(client, brandId, 'approver')
}

// Everyone who can approve content in the brand (the holders of approve_content): its approvers and brand
// admins, and, when the brand has neither, the platform owners. Never empty unless there is no platform owner
// either; the caller decides what to do then.
export async function approvalRecipientsOf(client: PoolClient, brandId: string): Promise<string[]> {
  const { rows } = await client.query<{ user_id: string }>(
    `select user_id from app.membership
      where brand_id = $1 and role in ('approver'::app.membership_role, 'brand_admin'::app.membership_role)
      order by created_at, user_id`,
    [brandId],
  )
  if (rows.length > 0) return rows.map((r) => r.user_id)
  const owners = await client.query<{ id: string }>('select app.platform_owner_ids() as id')
  return owners.rows.map((r) => r.id)
}

export async function brandAdminsOf(client: PoolClient, brandId: string): Promise<string[]> {
  return membersWith(client, brandId, 'brand_admin')
}

async function membersWith(client: PoolClient, brandId: string, role: string): Promise<string[]> {
  const { rows } = await client.query<{ user_id: string }>(
    'select user_id from app.membership where brand_id = $1 and role = $2::app.membership_role order by created_at, user_id',
    [brandId, role],
  )
  return rows.map((r) => r.user_id)
}

export async function platformOwnersOf(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>('select app.platform_owner_ids() as id')
  return rows.map((r) => r.id)
}

// The address of a user, read from the sign-in schema at send time. Null when there is no such user.
export async function emailOf(db: Pick<Pool, 'query'>, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ email: string }>('select email from auth."user" where id = $1', [userId])
  return rows[0]?.email ?? null
}
