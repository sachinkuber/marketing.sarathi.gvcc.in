import type { Pool } from '@mkt/db'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { readSettings, updateSettings } from '../approvals/settings.ts'
import { principalOf } from '../auth/session.ts'
import type { AuditSink } from '../ports.ts'
import { inputOf, validate } from '../validate.ts'

export interface ApprovalSettingsRouteDeps {
  pool: Pool
  audit: AuditSink
}

const params = z.strictObject({ brandId: z.uuid() })
// Whole minutes, at least one and at most a year; the count is the table's 1 to 5.
const minutes = z.number().int().min(1).max(525_600)
const body = z
  .strictObject({
    firstReminderAfterMinutes: minutes.optional(),
    reminderGapMinutes: minutes.optional(),
    reminderCount: z.number().int().min(1).max(5).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'at least one setting is needed')

export function registerApprovalSettingsRoutes(table: RouteTable, deps: ApprovalSettingsRouteDeps): void {
  table.add({
    method: 'get',
    path: '/brands/:brandId/approval-settings',
    access: { kind: 'permission', permission: 'edit_profile' },
    summary: "The brand's reminder timing and count for approval requests, in whole minutes",
    handlers: [
      validate({ params }),
      async (_req, res) => {
        res.json(await readSettings(deps.pool, brandContextOf(res).brandId))
      },
    ],
  })

  table.add({
    method: 'patch',
    path: '/brands/:brandId/approval-settings',
    access: { kind: 'permission', permission: 'edit_profile' },
    summary: 'Change reminder timing or count; effective from the next reminder check',
    handlers: [
      validate({ params, body }),
      async (_req, res) => {
        const { body: change } = inputOf<{ body: z.infer<typeof body> }>(res)
        res.json(
          await updateSettings(deps.pool, deps.audit, {
            brandId: brandContextOf(res).brandId,
            actorId: principalOf(res).userId,
            change,
          }),
        )
      },
    ],
  })
}
