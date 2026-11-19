import pg from 'pg'

// `alert <kind>` in the ops image: raises a severity 1 platform alert from the host, for the failures the core
// cannot see itself. The backup unit's OnFailure= runs it (infra/prod/backup/mkt-backup-alert.service).
//
// It goes through app.raise_alert, the database function the core's raiseAlert (apps/core/src/notify/alerts.ts)
// calls: same row, same dedupe (one open alert per kind, by its ref). It does not send anything itself. The core
// delivers it with the alerts it could not send at once: the worker timer's /worker/reconcile runs the notify
// stage, whose retryAlerts emails every platform owner (the second channel is not configured: owner decision A11), within one timer interval
// (RECONCILE_INTERVAL_SECONDS). So the ops container needs no mail or channel credentials, and no secret reaches a
// command line: the superuser's address comes from postgres.env, like `prepare`'s.
export const ALERT_KINDS = ['backup_failed'] as const
export type AlertKind = (typeof ALERT_KINDS)[number]

const isKind = (kind: string): kind is AlertKind => (ALERT_KINDS as readonly string[]).includes(kind)

export async function raiseOpsAlert(adminUrl: string, kind: string): Promise<{ created: boolean }> {
  if (!isKind(kind)) throw new Error(`Unknown alert kind. Kinds: ${ALERT_KINDS.join(', ')}.`)
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    const { rows } = await client.query<{ id: string | null }>(
      'select app.raise_alert(null, 1::smallint, $1, $2::jsonb) as id',
      [kind, JSON.stringify({ ref: kind, source: 'ops' })],
    )
    return { created: Boolean(rows[0]?.id) }
  } finally {
    await client.end()
  }
}

export async function alertFromEnv(env: Record<string, string | undefined>, args: string[]): Promise<void> {
  const [kind] = args
  if (!kind || args.length !== 1) throw new Error(`Usage: alert <kind>. Kinds: ${ALERT_KINDS.join(', ')}.`)
  const adminUrl = env.ADMIN_DATABASE_URL
  if (!adminUrl) throw new Error('Missing environment variables: ADMIN_DATABASE_URL.')
  if (adminUrl.includes('CHANGE_ME'))
    throw new Error('Refusing to alert: ADMIN_DATABASE_URL still contains CHANGE_ME.')
  const { created } = await raiseOpsAlert(adminUrl, kind)
  process.stdout.write(`${JSON.stringify({ event: 'alert_raised', kind, created })}\n`)
}
