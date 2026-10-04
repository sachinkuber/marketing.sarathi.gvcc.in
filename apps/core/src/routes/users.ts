import type { Pool } from '@mkt/db'
import { z } from 'zod'
import { verifySecondFactorCode } from '../access/step-up.ts'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { createInvite } from '../auth/invites.ts'
import { emailHash, type Auth } from '../auth/options.ts'
import { principalOf } from '../auth/session.ts'
import type { AuditSink, Mailer } from '../ports.ts'
import { changeMemberRole, listMembers, removeMember, resetSecondFactor } from '../users/service.ts'
import { inputOf, validate } from '../validate.ts'

export const ROLES = ['brand_admin', 'approver', 'sales_contact', 'viewer'] as const

const brandParams = z.strictObject({ brandId: z.uuid() })
const inviteBody = z.strictObject({ email: z.email().max(254), role: z.enum(ROLES) })

const memberParams = z.strictObject({ brandId: z.uuid(), userId: z.uuid() })
const code = z.string().regex(/^\d{6}$/)
const roleBody = z.strictObject({ role: z.enum(ROLES), code })
const removeBody = z.strictObject({ code })
const userParams = z.strictObject({ userId: z.uuid() })

export interface UserRouteDeps {
  auth: Auth
  pool: Pool
  mailer: Mailer
  audit: AuditSink
  origin: string
  onMailFailure?: (error: unknown) => void
}

export function registerUserRoutes(table: RouteTable, deps: UserRouteDeps): void {
  table.add({
    method: 'get',
    path: '/brands/:brandId/users',
    access: { kind: 'permission', permission: 'manage_users' },
    summary: 'The people of a brand, and its pending invites',
    handlers: [
      validate({ params: brandParams }),
      async (_req, res) => {
        res.json(await listMembers(deps.pool, brandContextOf(res).brandId))
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/users/invites',
    access: { kind: 'permission', permission: 'manage_users' },
    summary: 'Invite a person into a brand with a role',
    handlers: [
      validate({ params: brandParams, body: inviteBody }),
      async (_req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof inviteBody> }>(res)
        const brand = brandContextOf(res)
        const actor = principalOf(res).userId
        const invite = await createInvite(deps.pool, deps.mailer, {
          brandId: brand.brandId,
          email: body.email,
          role: body.role,
          invitedBy: actor,
          origin: deps.origin,
          onMailFailure: deps.onMailFailure,
          // In the invite's own transaction: if the audit entry cannot be written, there is no invite.
          inside: (_client, created) =>
            deps.audit.record({
              action: 'users.invited',
              actor,
              brandId: brand.brandId,
              outcome: 'success',
              detail: { role: body.role, emailHash: emailHash(body.email), inviteId: created.id },
            }),
        })
        res.status(201).json({ id: invite.id, expiresAt: invite.expiresAt })
      },
    ],
  })

  table.add({
    method: 'patch',
    path: '/brands/:brandId/users/:userId',
    access: { kind: 'permission', permission: 'manage_users' },
    summary: 'Change a person’s role in a brand (asks for the actor’s own code)',
    handlers: [
      validate({ params: memberParams, body: roleBody }),
      async (req, res) => {
        const { body, params } = inputOf<{
          body: z.infer<typeof roleBody>
          params: z.infer<typeof memberParams>
        }>(res)
        const actor = principalOf(res)
        await verifySecondFactorCode(deps.auth, req, body.code)
        const result = await changeMemberRole(deps.pool, deps.audit, {
          brandId: brandContextOf(res).brandId,
          actorId: actor.userId,
          actorIsPlatformOwner: actor.isPlatformOwner,
          targetId: params.userId,
          role: body.role,
        })
        res.json({ userId: result.userId, role: result.role })
      },
    ],
  })

  table.add({
    method: 'delete',
    path: '/brands/:brandId/users/:userId',
    access: { kind: 'permission', permission: 'manage_users' },
    summary: 'Remove a person from a brand (asks for the actor’s own code)',
    handlers: [
      validate({ params: memberParams, body: removeBody }),
      async (req, res) => {
        const { body, params } = inputOf<{
          body: z.infer<typeof removeBody>
          params: z.infer<typeof memberParams>
        }>(res)
        const actor = principalOf(res)
        await verifySecondFactorCode(deps.auth, req, body.code)
        await removeMember(deps.pool, deps.audit, {
          brandId: brandContextOf(res).brandId,
          actorId: actor.userId,
          actorIsPlatformOwner: actor.isPlatformOwner,
          targetId: params.userId,
        })
        res.status(204).end()
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/users/:userId/second-factor/reset',
    access: { kind: 'platform_owner' },
    summary: 'Reset a person’s second factor (platform owner only; asks for the owner’s own code)',
    handlers: [
      validate({ params: userParams, body: removeBody }),
      async (req, res) => {
        const { body, params } = inputOf<{
          body: z.infer<typeof removeBody>
          params: z.infer<typeof userParams>
        }>(res)
        const actor = principalOf(res)
        await verifySecondFactorCode(deps.auth, req, body.code)
        const target = await resetSecondFactor(deps.pool, deps.audit, {
          actorId: actor.userId,
          targetId: params.userId,
        })
        // After the reset is committed. A notification that cannot be sent is reported, never an error.
        try {
          await deps.mailer.send({
            to: target.email,
            subject: 'Your second factor was reset',
            text: 'The platform owner reset your second factor. You will be asked to set up a new one the next time you sign in. If you did not ask for this, contact the platform owner.',
          })
        } catch (error) {
          deps.onMailFailure?.(error)
        }
        res.status(204).end()
      },
    ],
  })
}
