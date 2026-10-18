import { withBrand, type Pool } from '@mkt/db'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { principalOf } from '../auth/session.ts'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'
import { inputOf, validate } from '../validate.ts'

export interface AlertRouteDeps {
  pool: Pool
  audit: AuditSink
}

const brandParams = z.strictObject({ brandId: z.uuid() })
const brandAlertParams = z.strictObject({ brandId: z.uuid(), alertId: z.uuid() })
const alertParams = z.strictObject({ alertId: z.uuid() })

const notFound = () => new AppError(404, 'not_found', 'There is nothing at this address.')

interface AlertRecord {
  id: string
  severity: number
  kind: string
  detail: unknown
  raised_at: Date
  acknowledged_by: string | null
  acknowledged_at: Date | null
  resolved_at: Date | null
  delivered_at: Date | null
  delivery_attempts: number
  delivery_stalled: boolean
  delivery_issue: string | null
}

const shape = (r: AlertRecord) => ({
  id: r.id,
  severity: r.severity,
  kind: r.kind,
  detail: r.detail,
  raisedAt: r.raised_at,
  acknowledgedBy: r.acknowledged_by,
  acknowledgedAt: r.acknowledged_at,
  resolvedAt: r.resolved_at,
  delivered: r.delivered_at !== null,
  deliveryAttempts: r.delivery_attempts,
  deliveryStalled: r.delivery_stalled,
  deliveryIssue: r.delivery_issue,
})

const COLUMNS =
  'id, severity, kind, detail, raised_at, acknowledged_by, acknowledged_at, resolved_at, delivered_at, delivery_attempts, delivery_stalled, delivery_issue'

export function registerAlertRoutes(table: RouteTable, deps: AlertRouteDeps): void {
  table.add({
    method: 'get',
    path: '/brands/:brandId/alerts',
    access: { kind: 'permission', permission: 'view_content' },
    summary: "The brand's alerts, newest first; platform-level alerts are never in it",
    handlers: [
      validate({ params: brandParams }),
      async (_req, res) => {
        const brandId = brandContextOf(res).brandId
        const rows = await withBrand(deps.pool, brandId, async (client) => {
          const found = await client.query<AlertRecord>(
            `select ${COLUMNS} from app.alert where brand_id = $1 order by raised_at desc, id limit 200`,
            [brandId],
          )
          return found.rows
        })
        res.json({ alerts: rows.map(shape) })
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/alerts/:alertId/ack',
    access: { kind: 'permission', permission: 'approve_content' },
    summary: 'Acknowledge an alert of the brand; repeating it changes nothing',
    handlers: [
      validate({ params: brandAlertParams }),
      async (_req, res) => {
        const { params } = inputOf<{ params: z.infer<typeof brandAlertParams> }>(res)
        const brandId = brandContextOf(res).brandId
        const userId = principalOf(res).userId
        const alert = await withBrand(deps.pool, brandId, async (client) => {
          // Another brand's alert, or a platform alert, is invisible here and so is a 404.
          const updated = await client.query<AlertRecord>(
            `update app.alert set acknowledged_by = $3, acknowledged_at = now()
              where id = $1 and brand_id = $2 and acknowledged_at is null returning ${COLUMNS}`,
            [params.alertId, brandId, userId],
          )
          if (updated.rows[0]) {
            await deps.audit.record(
              {
                action: 'alerts.acknowledged',
                actor: userId,
                brandId,
                subject: params.alertId,
                outcome: 'success',
                detail: { alertId: params.alertId },
              },
              client,
            )
            return updated.rows[0]
          }
          const existing = await client.query<AlertRecord>(
            `select ${COLUMNS} from app.alert where id = $1 and brand_id = $2`,
            [params.alertId, brandId],
          )
          return existing.rows[0] ?? null
        })
        if (!alert) throw notFound()
        res.json(shape(alert))
      },
    ],
  })

  table.add({
    method: 'get',
    path: '/alerts',
    access: { kind: 'platform_owner' },
    summary: 'The platform-level alerts, newest first',
    handlers: [
      async (_req, res) => {
        const found = await deps.pool.query<AlertRecord>('select * from app.list_platform_alerts()')
        res.json({ alerts: found.rows.map(shape) })
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/alerts/:alertId/ack',
    access: { kind: 'platform_owner' },
    summary: 'Acknowledge a platform-level alert; repeating it changes nothing',
    handlers: [
      validate({ params: alertParams }),
      async (_req, res) => {
        const { params } = inputOf<{ params: z.infer<typeof alertParams> }>(res)
        const userId = principalOf(res).userId
        // The acknowledgement and its audit entry are one transaction.
        const client = await deps.pool.connect()
        let found: boolean
        try {
          await client.query('begin')
          const result = await client.query<{ found: boolean; newly: boolean }>(
            'select found, newly from app.ack_platform_alert($1, $2)',
            [params.alertId, userId],
          )
          found = result.rows[0]?.found ?? false
          if (result.rows[0]?.newly) {
            await deps.audit.record(
              {
                action: 'alerts.acknowledged',
                actor: userId,
                brandId: null,
                subject: params.alertId,
                outcome: 'success',
                detail: { alertId: params.alertId },
              },
              client,
            )
          }
          await client.query('commit')
        } catch (error) {
          await client.query('rollback').catch(() => undefined)
          throw error
        } finally {
          client.release()
        }
        if (!found) throw notFound()
        const now = await deps.pool.query<AlertRecord>('select * from app.get_platform_alert($1)', [
          params.alertId,
        ])
        res.json(shape(now.rows[0] as AlertRecord))
      },
    ],
  })
}
