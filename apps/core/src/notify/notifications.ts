import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import { raiseAlert } from './alerts.ts'
import { errorName, overBudget, withSendTimeout, type NotifyDeps } from './ports.ts'
import { emailOf } from './recipients.ts'

// A notification is tried at most this many times; the last failure makes it `failed` and raises an alert.
export const MAX_ATTEMPTS = 5

export interface NewNotification {
  brandId: string
  userId: string
  kind: string
  subject?: { kind: string; id: string }
}

// Runs inside the caller's brand transaction, so the notification exists if and only if the change does.
// The state is `queued` (the enum of database schema 8.1 has no `pending`).
export async function enqueueNotification(client: PoolClient, n: NewNotification): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into app.notification (brand_id, user_id, kind, channel, subject_kind, subject_id)
     values ($1, $2, $3, 'email', $4, $5) returning id`,
    [n.brandId, n.userId, n.kind, n.subject?.kind ?? null, n.subject?.id ?? null],
  )
  return rows[0]!.id
}

interface Row {
  id: string
  user_id: string
  kind: string
  subject_kind: string | null
  attempts: number
}

// The text of a notification names the kind of thing, never its content: the person opens the application.
function messageFor(row: Row): { subject: string; text: string } {
  const what = row.subject_kind ? ` (${row.subject_kind})` : ''
  return {
    subject: `Marketing Sarathi: ${row.kind.replace(/_/g, ' ')}`,
    text: `Something needs your attention${what}: ${row.kind.replace(/_/g, ' ')}. Open Marketing Sarathi to see it.`,
  }
}

export interface DeliverResult {
  sent: number
  retried: number
  failed: number
}

// Sends the queued notifications (up to `limit`, oldest first), outside any caller transaction. Each is
// handled on its own: its row is locked for the send, so two deliverers never send the same one. A failure
// counts an attempt; the fifth makes it `failed` and raises a severity 2 alert. The log gets the error name
// only, never the address, the subject or the error message.
export async function deliverPending(
  pool: Pool,
  deps: NotifyDeps,
  limit: number,
  startedAt = Date.now(),
): Promise<DeliverResult> {
  const out: DeliverResult = { sent: 0, retried: 0, failed: 0 }
  const queued = await pool.query<{ id: string; brand_id: string }>(
    'select id, brand_id from app.pending_notifications($1, $2)',
    [limit, MAX_ATTEMPTS],
  )
  for (const { id, brand_id: brandId } of queued.rows) {
    if (overBudget(deps, startedAt)) break
    const outcome = await withBrand(pool, brandId, async (client) => {
      const found = await client.query<Row>(
        `select id, user_id, kind, subject_kind, attempts from app.notification
          where id = $1 and state = 'queued' and attempts < $2 for update skip locked`,
        [id, MAX_ATTEMPTS],
      )
      const row = found.rows[0]
      if (!row) return 'skipped' as const
      try {
        const to = await emailOf(client, row.user_id)
        if (!to) throw Object.assign(new Error('recipient'), { name: 'RecipientNotFound' })
        const receipt = await withSendTimeout(deps, () => deps.mailer.send({ to, ...messageFor(row) }))
        if (!receipt?.providerId)
          throw Object.assign(new Error('receipt'), { name: 'NoProviderConfirmation' })
        await client.query(
          `update app.notification set state = 'sent', provider_id = $2, sent_at = $3, attempts = attempts + 1
            where id = $1`,
          [id, receipt.providerId, deps.clock.now()],
        )
        return 'sent' as const
      } catch (error) {
        deps.logger?.warn({ err: errorName(error), notification: id }, 'notification not sent')
        const attempts = row.attempts + 1
        const last = attempts >= MAX_ATTEMPTS
        await client.query(`update app.notification set attempts = $2, state = $3 where id = $1`, [
          id,
          attempts,
          last ? 'failed' : 'queued',
        ])
        return last ? ('failed' as const) : ('retried' as const)
      }
    })
    if (outcome === 'sent') out.sent += 1
    else if (outcome === 'retried') out.retried += 1
    else if (outcome === 'failed') {
      out.failed += 1
      // A failure to raise must not end the loop; the notification stays failed and is found by the next
      // attempt of whoever raises it again (the ref dedupes).
      try {
        await raiseAlert(pool, deps, {
          brandId,
          severity: 2,
          kind: 'notification_failed',
          ref: id,
          detail: { notificationId: id },
        })
      } catch (error) {
        deps.logger?.error(
          { err: errorName(error), notification: id },
          'alert for a failed notification not raised',
        )
      }
    }
  }
  return out
}
