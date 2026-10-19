import { prepareVersion } from '@mkt/canonical'
import type { PoolClient } from '@mkt/db'
import { PAYLOAD_SCHEMA } from '@mkt/shared'
import { closeRequest, openRequest, WAITING_KIND } from '../approvals/requests.ts'
import { AppError } from '../errors.ts'
import { enqueueNotification } from '../notify/notifications.ts'
import { approvalRecipientsOf } from '../notify/recipients.ts'
import type { AuditSink } from '../ports.ts'
import { OPEN_STATES, canMove, type VersionState } from './states.ts'

export interface VersionDeps {
  audit: AuditSink
}

export interface Actor {
  kind: 'user' | 'agent' | 'system' | 'n8n'
  userId?: string
  runId?: string
}

const actorId = (actor: Actor): string | null => actor.userId ?? actor.runId ?? null

export interface NewVersion {
  brandId: string
  contentItemId: string
  // The payload as the client or an agent supplies it: the server adds brand_id, content_item_id and schema.
  payload: Record<string, unknown>
  createdBy: Actor
}

// Moves a version along an allowed transition: the state, its history row and its audit entry in the caller's
// transaction. Entering awaiting_approval opens the approval request; leaving it closes it.
export async function moveState(
  client: PoolClient,
  deps: VersionDeps,
  versionId: string,
  to: VersionState,
  actor: Actor,
  cause: string = to,
): Promise<void> {
  const found = await client.query<{ brand_id: string; state: VersionState }>(
    'select brand_id, state from app.content_version_state where content_version_id = $1 for update',
    [versionId],
  )
  const row = found.rows[0]
  if (!row) throw new AppError(404, 'not_found', 'There is nothing at this address.')
  if (!canMove(row.state, to)) {
    throw new AppError(409, 'invalid_transition', `A version cannot move from ${row.state} to ${to}.`)
  }
  await client.query(
    'update app.content_version_state set state = $2, updated_at = now() where content_version_id = $1',
    [versionId, to],
  )
  await client.query(
    `insert into app.content_version_state_change
       (brand_id, content_version_id, from_state, to_state, cause, actor_kind, actor_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [row.brand_id, versionId, row.state, to, cause, actor.kind, actorId(actor)],
  )
  if (to === 'awaiting_approval') {
    const opened = await openRequest(client, { brandId: row.brand_id, versionId })
    // Spec 10.5: the approvers are told when a version reaches awaiting approval. Only the call that opened the
    // request tells them, so a repeat sends nothing; the notification is in this transaction, like the state.
    if (opened) {
      const recipients = await approvalRecipientsOf(client, row.brand_id)
      for (const userId of recipients) {
        await enqueueNotification(client, {
          brandId: row.brand_id,
          userId,
          kind: WAITING_KIND,
          subject: { kind: 'content_version', id: versionId },
        })
      }
      if (recipients.length === 0) {
        await deps.audit.record(
          {
            action: 'approval.no_recipient',
            actor: null,
            subject: versionId,
            brandId: row.brand_id,
            outcome: 'failure',
            detail: { kind: WAITING_KIND },
          },
          client,
        )
      }
    }
  }
  if (row.state === 'awaiting_approval') await closeRequest(client, versionId, cause)
  await deps.audit.record(
    {
      action: 'content.state_changed',
      actor: actorId(actor),
      subject: versionId,
      brandId: row.brand_id,
      outcome: 'success',
      detail: { from: row.state, to, cause },
    },
    client,
  )
}

// Makes the next version of an item. Throws PayloadRejected (before any write) for a payload that cannot be
// stored; an item that is not the brand's is a 404.
export async function createVersion(
  client: PoolClient,
  deps: VersionDeps,
  input: NewVersion,
): Promise<{ versionId: string; number: number; hash: string }> {
  const prepared = prepareVersion({
    ...input.payload,
    schema: PAYLOAD_SCHEMA,
    brand_id: input.brandId,
    content_item_id: input.contentItemId,
  })

  const item = await client.query<{ kind: string; current_version_id: string | null }>(
    'select kind, current_version_id from app.content_item where brand_id = $1 and id = $2 for update',
    [input.brandId, input.contentItemId],
  )
  const row = item.rows[0]
  if (!row) throw new AppError(404, 'not_found', 'There is nothing at this address.')
  if (row.kind !== prepared.payload.kind) {
    throw new AppError(400, 'kind_mismatch', 'The version is of a different kind than the item.')
  }

  const next = await client.query<{ n: number }>(
    'select coalesce(max(number), 0) + 1 as n from app.content_version where content_item_id = $1',
    [input.contentItemId],
  )
  const number = Number(next.rows[0]!.n)
  const inserted = await client.query<{ id: string }>(
    `insert into app.content_version
       (brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by_kind,
        created_by_user, created_by_run)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      input.brandId,
      input.contentItemId,
      number,
      prepared.canonical,
      prepared.hash,
      prepared.hashScheme,
      input.createdBy.kind,
      input.createdBy.userId ?? null,
      input.createdBy.runId ?? null,
    ],
  )
  const versionId = inserted.rows[0]!.id
  await client.query(
    `insert into app.content_version_state (brand_id, content_version_id, state) values ($1, $2, 'draft')`,
    [input.brandId, versionId],
  )
  await client.query(
    `insert into app.content_version_state_change
       (brand_id, content_version_id, from_state, to_state, cause, actor_kind, actor_id)
     values ($1, $2, null, 'draft', 'created', $3, $4)`,
    [input.brandId, versionId, input.createdBy.kind, actorId(input.createdBy)],
  )

  // The previous version is replaced only while it is still open.
  if (row.current_version_id) {
    const previous = await client.query<{ state: VersionState }>(
      'select state from app.content_version_state where content_version_id = $1',
      [row.current_version_id],
    )
    const state = previous.rows[0]?.state
    if (state && OPEN_STATES.includes(state)) {
      await moveState(client, deps, row.current_version_id, 'superseded', input.createdBy, 'superseded')
    }
  }
  await client.query('update app.content_item set current_version_id = $2 where brand_id = $1 and id = $3', [
    input.brandId,
    versionId,
    input.contentItemId,
  ])

  await deps.audit.record(
    {
      action: 'content.version_created',
      actor: actorId(input.createdBy),
      subject: versionId,
      brandId: input.brandId,
      outcome: 'success',
      detail: { contentItemId: input.contentItemId, number, hash: prepared.hash },
    },
    client,
  )
  return { versionId, number, hash: prepared.hash }
}
