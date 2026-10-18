import { withBrand, type Pool } from '@mkt/db'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'

// The API speaks whole minutes; the table keeps intervals. The tick reads the row fresh, so a change takes
// effect from the next tick.
export interface ApprovalSettings {
  firstReminderAfterMinutes: number
  reminderGapMinutes: number
  reminderCount: number
}

const SELECT = `select (extract(epoch from first_reminder_after) / 60)::int as first_minutes,
                       (extract(epoch from reminder_gap) / 60)::int as gap_minutes,
                       reminder_count::int as count
                  from app.approval_setting where brand_id = $1`

interface Row {
  first_minutes: number
  gap_minutes: number
  count: number
}

const shape = (r: Row): ApprovalSettings => ({
  firstReminderAfterMinutes: r.first_minutes,
  reminderGapMinutes: r.gap_minutes,
  reminderCount: r.count,
})

const notFound = () => new AppError(404, 'not_found', 'There is nothing at this address.')

export async function readSettings(pool: Pool, brandId: string): Promise<ApprovalSettings> {
  return withBrand(pool, brandId, async (client) => {
    const found = await client.query<Row>(SELECT, [brandId])
    if (!found.rows[0]) throw notFound()
    return shape(found.rows[0])
  })
}

export async function updateSettings(
  pool: Pool,
  audit: AuditSink,
  input: { brandId: string; actorId: string; change: Partial<ApprovalSettings> },
): Promise<ApprovalSettings> {
  return withBrand(pool, input.brandId, async (client) => {
    const before = await client.query<Row>(`${SELECT} for update`, [input.brandId])
    if (!before.rows[0]) throw notFound()
    const old = shape(before.rows[0])
    const next = { ...old, ...input.change }
    await client.query(
      `update app.approval_setting
          set first_reminder_after = make_interval(mins => $2),
              reminder_gap = make_interval(mins => $3),
              reminder_count = $4,
              updated_by = $5,
              updated_at = now()
        where brand_id = $1`,
      [
        input.brandId,
        next.firstReminderAfterMinutes,
        next.reminderGapMinutes,
        next.reminderCount,
        input.actorId,
      ],
    )
    await audit.record(
      {
        action: 'approval_settings.updated',
        actor: input.actorId,
        subject: input.brandId,
        brandId: input.brandId,
        outcome: 'success',
        detail: { from: old, to: next },
      },
      client,
    )
    return next
  })
}
