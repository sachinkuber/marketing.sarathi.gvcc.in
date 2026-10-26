import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { grantFor, type Actor } from '../access/permissions.ts'
import { principalOf } from '../auth/session.ts'
import { visibleBrands } from './brands.ts'
import type { AuditSink } from '../ports.ts'
import { inputOf, validate } from '../validate.ts'

export interface OverdueRouteDeps {
  pool: Pool
  audit: AuditSink
}

const params = z.strictObject({ brandId: z.uuid() })
const ackBody = z.strictObject({ choice: z.enum(['review_now', 'later']) })

interface OverdueRow {
  request_id: string
  content_item_id: string
  content_version_id: string
  title: string | null
  requested_at: Date
  overdue_since: Date
  shown: boolean
}

// The brand's open overdue requests whose version still waits for approval, oldest first. A decision or a
// supersede closes the request, so a decided item is never here.
//
// overdue_since is when the item became overdue by the rule the reminder tick applies: the last reminder plus
// one gap. (The tick may mark it a little later; the table keeps no overdue time of its own.)
//
// `shown` is whether this person has already answered the pop-up for this request in this sign-in: a popup_ack
// row of theirs for the request made at or after the session began. Both times are taken on the application
// host, never from the database clock.
export async function overdueFor(
  client: PoolClient,
  brandId: string,
  userId: string,
  sessionStartedAt: Date,
) {
  const found = await client.query<OverdueRow>(
    `select r.id as request_id, v.content_item_id, r.content_version_id,
            v.payload_canonical::jsonb ->> 'title' as title,
            r.requested_at,
            coalesce(r.last_reminder_at + s.reminder_gap, r.requested_at) as overdue_since,
            exists (select 1 from app.popup_ack a
                     where a.brand_id = r.brand_id and a.approval_request_id = r.id
                       and a.user_id = $2 and a."at" >= $3) as shown
       from app.approval_request r
       join app.content_version v on v.id = r.content_version_id and v.brand_id = r.brand_id
       join app.content_version_state st on st.content_version_id = r.content_version_id and st.brand_id = r.brand_id
       join app.approval_setting s on s.brand_id = r.brand_id
      where r.brand_id = $1 and r.overdue and r.closed_at is null and st.state = 'awaiting_approval'
      order by overdue_since, r.id`,
    [brandId, userId, sessionStartedAt],
  )
  return found.rows
}

export function registerOverdueRoutes(table: RouteTable, deps: OverdueRouteDeps): void {
  // One read across the caller's brands, so the pop-up can open on any screen without a poll per brand. Only
  // brands where the caller may approve are looked at (a member with approve_content; the platform owner for
  // every brand), and only those with something overdue are listed. Each brand is read inside withBrand with
  // that brand's own rule, so one brand's items can never appear under another.
  table.add({
    method: 'get',
    path: '/overdue',
    access: { kind: 'enrolled' },
    summary: 'Overdue approval requests across the brands the caller may approve in, with the pop-up state',
    handlers: [
      async (_req, res) => {
        const principal = principalOf(res)
        const brands: Array<Record<string, unknown>> = []
        for (const brand of await visibleBrands(deps.pool, principal)) {
          if (!grantFor(brand.role as Actor, 'approve_content')) continue
          const rows = await withBrand(deps.pool, brand.id, (client) =>
            overdueFor(client, brand.id, principal.userId, principal.sessionStartedAt),
          )
          const first = rows[0]
          if (!first) continue
          brands.push({
            brandId: brand.id,
            brandName: brand.name,
            count: rows.length,
            popupDue: rows.some((r) => !r.shown),
            firstRequestId: first.request_id,
            firstItemId: first.content_item_id,
            items: rows.map((r) => ({
              contentItemId: r.content_item_id,
              versionId: r.content_version_id,
              title: r.title ?? undefined,
              overdueSince: r.overdue_since,
              requestedAt: r.requested_at,
            })),
          })
        }
        res.json({ brands })
      },
    ],
  })

  table.add({
    method: 'get',
    path: '/brands/:brandId/approvals/overdue',
    access: { kind: 'permission', permission: 'approve_content' },
    summary: "The brand's overdue approval requests, the banner count and whether the pop-up is due",
    handlers: [
      validate({ params }),
      async (_req, res) => {
        const principal = principalOf(res)
        const rows = await withBrand(deps.pool, brandContextOf(res).brandId, (client) =>
          overdueFor(client, brandContextOf(res).brandId, principal.userId, principal.sessionStartedAt),
        )
        res.json({
          items: rows.map((r) => ({
            contentItemId: r.content_item_id,
            versionId: r.content_version_id,
            title: r.title ?? undefined,
            overdueSince: r.overdue_since,
            requestedAt: r.requested_at,
          })),
          // The banner number. Answering the pop-up never changes it; only a decision or supersede does.
          count: rows.length,
          // The pop-up is due while any overdue item has not been answered by this person since this
          // sign-in began. A new sign-in is a new session, so it is due again while any item remains; an
          // item that becomes overdue after an answer has no answer yet, so it makes the pop-up due again.
          popup: { due: rows.some((r) => !r.shown) },
        })
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/approvals/overdue/ack',
    access: { kind: 'permission', permission: 'approve_content' },
    summary: 'Record the answer to the overdue pop-up (review now or later) for the items it showed',
    handlers: [
      validate({ params, body: ackBody }),
      async (_req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof ackBody> }>(res)
        const principal = principalOf(res)
        const brandId = brandContextOf(res).brandId
        const acknowledged = await withBrand(deps.pool, brandId, async (client) => {
          const rows = await overdueFor(client, brandId, principal.userId, principal.sessionStartedAt)
          for (const r of rows) {
            await client.query(
              `insert into app.popup_ack (brand_id, user_id, approval_request_id, choice, "at")
               values ($1, $2, $3, $4, $5)`,
              [brandId, principal.userId, r.request_id, body.choice, new Date()],
            )
          }
          await deps.audit.record(
            {
              action: 'approval.popup_acknowledged',
              actor: principal.userId,
              subject: brandId,
              brandId,
              outcome: 'success',
              detail: { choice: body.choice, versionIds: rows.map((r) => r.content_version_id) },
            },
            client,
          )
          return rows.length
        })
        res.status(201).json({ choice: body.choice, acknowledged })
      },
    ],
  })
}
