import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import type { Role } from '../auth/session.ts'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'

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

interface Actor {
  brandId: string
  actorId: string
  actorIsPlatformOwner: boolean
  targetId: string
}

// Everything below runs in one transaction with the brand set. The brand's membership rows are locked first,
// so two requests that would together leave the brand with no admin cannot both pass the check.
async function lockMembers(client: PoolClient, brandId: string) {
  const result = await client.query(
    'select user_id, role from app.membership where brand_id = $1 for update',
    [brandId],
  )
  return result.rows as { user_id: string; role: Role }[]
}

async function guardTarget(client: PoolClient, input: Actor, members: { user_id: string; role: Role }[]) {
  const target = members.find((m) => m.user_id === input.targetId)
  if (!target) throw new AppError(404, 'not_found', 'There is nothing at this address.')
  if (input.targetId === input.actorId) {
    throw new AppError(
      409,
      'cannot_change_own_membership',
      'You cannot change or remove your own membership here.',
    )
  }
  if (!input.actorIsPlatformOwner) {
    const owner = await client.query('select app.is_platform_owner($1) as owner', [input.targetId])
    if (owner.rows[0].owner) throw new AppError(403, 'forbidden', 'You do not have permission to do this.')
  }
  return target
}

function lastAdmin(members: { role: Role }[]): boolean {
  return members.filter((m) => m.role === 'brand_admin').length <= 1
}

export async function changeMemberRole(
  pool: Pool,
  audit: AuditSink,
  input: Actor & { role: Role },
): Promise<{ userId: string; role: Role; changed: boolean }> {
  return withBrand(pool, input.brandId, async (client) => {
    const members = await lockMembers(client, input.brandId)
    const target = await guardTarget(client, input, members)
    if (target.role === input.role) return { userId: input.targetId, role: input.role, changed: false }
    if (target.role === 'brand_admin' && lastAdmin(members)) {
      throw new AppError(
        409,
        'last_admin',
        'A brand needs at least one admin. Make someone else an admin first.',
      )
    }
    await client.query('update app.membership set role = $1 where brand_id = $2 and user_id = $3', [
      input.role,
      input.brandId,
      input.targetId,
    ])
    // In the same transaction: if the entry cannot be written, the change is rolled back.
    await audit.record({
      action: 'users.role_changed',
      actor: input.actorId,
      subject: input.targetId,
      brandId: input.brandId,
      outcome: 'success',
      detail: { from: target.role, to: input.role },
    })
    return { userId: input.targetId, role: input.role, changed: true }
  })
}

export async function removeMember(pool: Pool, audit: AuditSink, input: Actor): Promise<void> {
  await withBrand(pool, input.brandId, async (client) => {
    const members = await lockMembers(client, input.brandId)
    const target = await guardTarget(client, input, members)
    if (target.role === 'brand_admin' && lastAdmin(members)) {
      throw new AppError(
        409,
        'last_admin',
        'A brand needs at least one admin. Make someone else an admin first.',
      )
    }
    await client.query('delete from app.membership where brand_id = $1 and user_id = $2', [
      input.brandId,
      input.targetId,
    ])
    // Their account stays (other tables refer to it). With no membership left, and not the platform owner,
    // they have nothing to do here: end their sessions.
    const left = await client.query('select count(*)::int as n from app.memberships_for_user($1)', [
      input.targetId,
    ])
    const owner = await client.query('select app.is_platform_owner($1) as owner', [input.targetId])
    if (left.rows[0].n === 0 && !owner.rows[0].owner) {
      await client.query('delete from auth.session where "userId" = $1', [input.targetId])
    }
    await audit.record({
      action: 'users.removed',
      actor: input.actorId,
      subject: input.targetId,
      brandId: input.brandId,
      outcome: 'success',
      detail: { role: target.role },
    })
  })
}

// The platform owner resets a person's second factor (spec section 7). One transaction: the person's
// secret and backup codes, the enabled flag and every session go together, and so does the audit entry.
export async function resetSecondFactor(
  pool: Pool,
  audit: AuditSink,
  input: { actorId: string; targetId: string },
): Promise<{ email: string }> {
  if (input.actorId === input.targetId) {
    throw new AppError(
      409,
      'cannot_reset_own_second_factor',
      'The owner’s own second factor is reset by the documented server-side procedure.',
    )
  }
  const client = await pool.connect()
  try {
    await client.query('begin')
    const user = await client.query('select email from auth."user" where id = $1', [input.targetId])
    if (user.rowCount === 0) throw new AppError(404, 'not_found', 'There is nothing at this address.')
    await client.query('delete from auth."twoFactor" where "userId" = $1', [input.targetId])
    await client.query('update auth."user" set "twoFactorEnabled" = false where id = $1', [input.targetId])
    await client.query('delete from auth.session where "userId" = $1', [input.targetId])
    await audit.record({
      action: 'users.second_factor_reset',
      actor: input.actorId,
      subject: input.targetId,
      brandId: null,
      outcome: 'success',
    })
    await client.query('commit')
    return { email: user.rows[0].email as string }
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
