import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import { enqueueNotification } from '../notify/notifications.ts'
import { errorName, type NotifyDeps } from '../notify/ports.ts'
import { approvalRecipientsOf, brandAdminsOf, platformOwnersOf } from '../notify/recipients.ts'

// THE lock order of the service, for every path that takes more than one of these (tests: lock-order.test.ts):
//   1. the brand row (a release takes it FOR UPDATE; job creation, a result post and this tick take it FOR SHARE)
//   2. job_input   3. run   4. content rows (item, version, state)   5. approval_request   6. the audit chain
// A path takes the locks it needs in that order and never goes back. The tick below takes the brand row first,
// then locks request rows, then writes audit entries and notifications (a notification's brand reference
// would otherwise ask for the brand row after the audit chain is held, against a release that holds the
// brand row and asks for the chain). A result handler that moves a version to awaiting_approval reaches
// approval_request (5) after job_input and run; a kill-switch release writes its own entry (6) last.
//
// openRequest and closeRequest are idempotent and run inside the caller's withBrand transaction.

// A version has at most one request, ever (a full unique on the version), so opening twice changes nothing.
// Returns whether this call opened it.
export async function openRequest(
  client: PoolClient,
  input: { brandId: string; versionId: string },
): Promise<boolean> {
  const opened = await client.query(
    `insert into app.approval_request (brand_id, content_version_id) values ($1, $2)
     on conflict (content_version_id) do nothing`,
    [input.brandId, input.versionId],
  )
  return (opened.rowCount ?? 0) > 0
}

// Closing an absent or already-closed request does nothing. Returns whether a request was closed by this call.
// The reason belongs to the caller's audit entry; the table has no column for it.
export async function closeRequest(client: PoolClient, versionId: string, reason: string): Promise<boolean> {
  void reason
  const closed = await client.query(
    `update app.approval_request set closed_at = now()
      where content_version_id = $1 and closed_at is null`,
    [versionId],
  )
  return (closed.rowCount ?? 0) > 0
}

export interface TickResult {
  // Brands whose work failed and was rolled back; the other brands were still done.
  failedBrands: number
  reminded: number
  overdue: number
  escalated: number
}

export const WAITING_KIND = 'approval_waiting'
export const REMINDER_KIND = 'approval_reminder'
export const OVERDUE_KIND = 'approval_overdue'

interface OpenRow {
  id: string
  content_version_id: string
  reminder_due: boolean
  overdue_due: boolean
  escalate_due: boolean
  escalated_to: string | null
}

// The reminders and escalation for every open request. Silence is not approval: this writes only the request's
// own counters, notifications and audit entries. It never inserts an approval, moves a version or creates an
// outbox action.
//
// Per request, at most one step per call: a reminder (number n is due at requested_at + first + (n-1) * gap, while
// fewer than `reminder_count` have gone), or, once all reminders have gone and one gap has passed since the last,
// overdue plus escalation to the brand admins, or, one gap after that, escalation to the platform owners. After a
// long outage one call therefore sends one reminder and the next call the next one, never a burst.
//
// The time is the injected clock's, passed to the database as a value (never now()), and the settings are read
// in the same statement, so a change made a moment ago is used. Each request row is locked (skip locked) for its
// step, so two overlapping calls never send the same reminder.
export async function tick(
  pool: Pool,
  deps: Pick<NotifyDeps, 'clock' | 'audit' | 'logger'>,
): Promise<TickResult> {
  const result: TickResult = { failedBrands: 0, reminded: 0, overdue: 0, escalated: 0 }
  const brands = await pool.query<{ id: string }>('select app.brands_with_open_requests() as id')
  const owners = await platformOwnersOf(pool)
  for (const { id: brandId } of brands.rows) {
    const now = deps.clock.now()
    const mine = { reminded: 0, overdue: 0, escalated: 0 }
    try {
      await withBrand(pool, brandId, async (client) => {
        // Lock order, step 1: the brand row, shared like job creation takes it, so a release (FOR UPDATE)
        // finishes first and this brand's tick never holds a later lock while waiting for it.
        await client.query('select 1 from app.brand where id = $1 for share', [brandId])
        const open = await client.query<OpenRow>(
          `select r.id, r.content_version_id, r.escalated_to,
                (r.reminders_sent < s.reminder_count
                 and $2 >= greatest(r.requested_at + s.first_reminder_after + r.reminders_sent * s.reminder_gap,
                                    coalesce(r.last_reminder_at + s.reminder_gap, r.requested_at))) as reminder_due,
                (r.reminders_sent >= s.reminder_count and not r.overdue
                 and $2 >= coalesce(r.last_reminder_at, r.requested_at) + s.reminder_gap) as overdue_due,
                (r.overdue and r.escalated_at is not null
                 and $2 >= r.escalated_at + s.reminder_gap) as escalate_due
           from app.approval_request r
           join app.content_version_state st
             on st.content_version_id = r.content_version_id and st.brand_id = r.brand_id
           join app.approval_setting s on s.brand_id = r.brand_id
          where r.brand_id = $1 and r.closed_at is null and st.state = 'awaiting_approval'
          order by r.requested_at, r.id
            for update of r skip locked`,
          [brandId, now],
        )
        if (open.rows.length === 0) return
        const approvers = await approvalRecipientsOf(client, brandId)
        const admins = await brandAdminsOf(client, brandId)
        const subject = (row: OpenRow) => ({ kind: 'content_version', id: row.content_version_id })
        const tell = async (users: string[], kind: string, row: OpenRow) => {
          for (const userId of users) {
            await enqueueNotification(client, { brandId, userId, kind, subject: subject(row) })
          }
        }
        const audit = (action: string, row: OpenRow, detail: Record<string, unknown>) =>
          deps.audit.record(
            { action, actor: null, subject: row.content_version_id, brandId, outcome: 'success', detail },
            client,
          )
        for (const row of open.rows) {
          if (row.reminder_due) {
            if (approvers.length === 0) {
              // Nobody can approve here (no approver, brand admin or platform owner): the reminder is not
              // counted as sent, so it goes out as soon as there is someone to tell.
              deps.logger?.warn({ brand: brandId, request: row.id }, 'approval reminder has no recipient')
              continue
            }
            await tell(approvers, REMINDER_KIND, row)
            await client.query(
              'update app.approval_request set reminders_sent = reminders_sent + 1, last_reminder_at = $2 where id = $1',
              [row.id, now],
            )
            mine.reminded += 1
          } else if (row.overdue_due) {
            // A platform owner who is the only approver cannot be escalated above: overdue only.
            const ownerOnly = approvers.length > 0 && approvers.every((a) => owners.includes(a))
            const targets = ownerOnly ? [] : admins.length > 0 ? admins : owners
            const first = targets[0] ?? null
            await client.query(
              'update app.approval_request set overdue = true, escalated_to = $2, escalated_at = $3 where id = $1',
              [row.id, first, first ? now : null],
            )
            await audit('approval.overdue', row, { requestId: row.id })
            mine.overdue += 1
            if (first) {
              await tell(targets, OVERDUE_KIND, row)
              await audit('approval.escalated', row, {
                requestId: row.id,
                to: admins.length > 0 ? 'brand_admin' : 'platform_owner',
              })
              mine.escalated += 1
            }
          } else if (row.escalate_due && row.escalated_to !== null && !owners.includes(row.escalated_to)) {
            // The brand admins have had a gap; now the platform owners. The last level, so nothing follows.
            const first = owners[0]
            if (!first) continue
            await client.query(
              'update app.approval_request set escalated_to = $2, escalated_at = $3 where id = $1',
              [row.id, first, now],
            )
            await tell(owners, OVERDUE_KIND, row)
            await audit('approval.escalated', row, { requestId: row.id, to: 'platform_owner' })
            mine.escalated += 1
          }
        }
      })
    } catch (error) {
      // One brand's failure (rolled back whole) must not starve the brands after it.
      result.failedBrands += 1
      deps.logger?.error({ err: errorName(error), brand: brandId }, 'approval reminders failed for a brand')
      continue
    }
    result.reminded += mine.reminded
    result.overdue += mine.overdue
    result.escalated += mine.escalated
  }
  return result
}
