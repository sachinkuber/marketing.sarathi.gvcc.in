import { PayloadRejected } from '@mkt/canonical'
import { withBrand, type Pool } from '@mkt/db'
import { contentPayloadSchema } from '@mkt/shared'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { principalOf } from '../auth/session.ts'
import { VERSION_STATES } from '../content/states.ts'
import { createVersion } from '../content/versions.ts'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'
import { inputOf, validate } from '../validate.ts'

export interface ContentRouteDeps {
  pool: Pool
  audit: AuditSink
}

const brandParams = z.strictObject({ brandId: z.uuid() })
const itemParams = z.strictObject({ brandId: z.uuid(), itemId: z.uuid() })
const listQuery = z.strictObject({
  state: z.enum(VERSION_STATES).optional(),
  overdue: z.enum(['true', 'false']).optional(),
})
// What a client may send: the payload without the fields the server owns.
const editBody = contentPayloadSchema.omit({ schema: true, brand_id: true, content_item_id: true })

const notFound = () => new AppError(404, 'not_found', 'There is nothing at this address.')

export function registerContentRoutes(table: RouteTable, deps: ContentRouteDeps): void {
  table.add({
    method: 'get',
    path: '/brands/:brandId/content',
    access: { kind: 'permission', permission: 'view_content' },
    summary: 'The content of a brand with the state of each current version, filtered by state or overdue',
    handlers: [
      validate({ params: brandParams, query: listQuery }),
      async (_req, res) => {
        const { query } = inputOf<{ query: z.infer<typeof listQuery> }>(res)
        const brandId = brandContextOf(res).brandId
        const rows = await withBrand(deps.pool, brandId, async (client) => {
          const found = await client.query(
            `select i.id, i.kind, i.current_version_id, v.number, s.state, v.created_at,
                    v.payload_canonical::jsonb ->> 'title' as title,
                    coalesce(r.overdue, false) as overdue, r.requested_at
               from app.content_item i
               left join app.content_version v on v.id = i.current_version_id
               left join app.content_version_state s on s.content_version_id = v.id
               left join app.approval_request r on r.content_version_id = v.id and r.closed_at is null
              where i.brand_id = $1
                and ($2::app.version_state is null or s.state = $2)
                and ($3::boolean is null or coalesce(r.overdue, false) = $3)
              order by coalesce(v.created_at, i.created_at) desc, i.id
              limit 200`,
            [brandId, query.state ?? null, query.overdue === undefined ? null : query.overdue === 'true'],
          )
          return found.rows
        })
        res.json({
          items: rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            currentVersionId: r.current_version_id,
            number: r.number,
            state: r.state,
            title: r.title,
            overdue: r.overdue,
            requestedAt: r.requested_at,
            createdAt: r.created_at,
          })),
        })
      },
    ],
  })

  table.add({
    method: 'get',
    path: '/brands/:brandId/content/:itemId',
    access: { kind: 'permission', permission: 'view_content' },
    summary: 'One content item with all its versions and their states',
    handlers: [
      validate({ params: itemParams }),
      async (_req, res) => {
        const { params } = inputOf<{ params: z.infer<typeof itemParams> }>(res)
        const brandId = brandContextOf(res).brandId
        const result = await withBrand(deps.pool, brandId, async (client) => {
          const item = await client.query(
            'select id, kind, current_version_id, created_at from app.content_item where brand_id = $1 and id = $2',
            [brandId, params.itemId],
          )
          if (item.rowCount === 0) return null
          const versions = await client.query(
            `select v.id, v.number, v.hash, v.hash_scheme, v.payload_canonical, v.created_by_kind,
                    v.created_by_user, v.created_by_run, v.created_at, s.state, s.updated_at
               from app.content_version v
               join app.content_version_state s on s.content_version_id = v.id
              where v.brand_id = $1 and v.content_item_id = $2
              order by v.number`,
            [brandId, params.itemId],
          )
          return { item: item.rows[0], versions: versions.rows }
        })
        if (!result) throw notFound()
        res.json({
          id: result.item.id,
          kind: result.item.kind,
          currentVersionId: result.item.current_version_id,
          createdAt: result.item.created_at,
          versions: result.versions.map((v) => ({
            id: v.id,
            number: v.number,
            state: v.state,
            stateChangedAt: v.updated_at,
            hash: v.hash,
            hashScheme: v.hash_scheme,
            payload: JSON.parse(v.payload_canonical as string),
            createdBy: { kind: v.created_by_kind, userId: v.created_by_user, runId: v.created_by_run },
            createdAt: v.created_at,
          })),
        })
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/content/:itemId/versions',
    access: { kind: 'permission', permission: 'approve_content' },
    summary: 'Edit a content item: store the payload as its next version',
    handlers: [
      validate({ params: itemParams, body: editBody }),
      async (_req, res) => {
        const { params, body } = inputOf<{
          params: z.infer<typeof itemParams>
          body: Record<string, unknown>
        }>(res)
        const brandId = brandContextOf(res).brandId
        try {
          const created = await withBrand(deps.pool, brandId, (client) =>
            createVersion(client, deps, {
              brandId,
              contentItemId: params.itemId,
              payload: body,
              createdBy: { kind: 'user', userId: principalOf(res).userId },
            }),
          )
          res.status(201).json(created)
        } catch (error) {
          if (error instanceof PayloadRejected) {
            throw new AppError(400, 'payload_rejected', 'The content cannot be stored.', {
              path: error.path,
              message: error.message,
            })
          }
          throw error
        }
      },
    ],
  })
}
