import type { Pool } from '@mkt/db'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { createInvite } from '../auth/invites.ts'
import { emailHash } from '../auth/options.ts'
import { principalOf } from '../auth/session.ts'
import type { AuditSink, Mailer } from '../ports.ts'
import { listMembers } from '../users/service.ts'
import { inputOf, validate } from '../validate.ts'

export const ROLES = ['brand_admin', 'approver', 'sales_contact', 'viewer'] as const

const brandParams = z.strictObject({ brandId: z.uuid() })
const inviteBody = z.strictObject({ email: z.email().max(254), role: z.enum(ROLES) })

export interface UserRouteDeps {
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
}
