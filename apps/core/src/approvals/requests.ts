import type { PoolClient } from '@mkt/db'

// Plain SQL; the clock, reminders and escalation are added to this file by the approvals clock.
// Both calls are idempotent and run inside the caller's withBrand transaction.

// A version has at most one request, ever (a full unique on the version), so opening twice changes nothing.
export async function openRequest(
  client: PoolClient,
  input: { brandId: string; versionId: string },
): Promise<void> {
  await client.query(
    `insert into app.approval_request (brand_id, content_version_id) values ($1, $2)
     on conflict (content_version_id) do nothing`,
    [input.brandId, input.versionId],
  )
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
