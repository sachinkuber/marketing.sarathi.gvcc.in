import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseUrl, requireDatabase } from '@mkt/test-support'
import { createTestDatabase, type TestDatabase } from '@mkt/db/testing'
import { ALERT_KINDS, alertFromEnv, raiseOpsAlert } from '../src/alert.ts'

// The `alert` command (plan, Task 8 step 3): the backup unit's OnFailure= runs it. It raises a severity 1
// platform alert through app.raise_alert, the function the core's raiseAlert calls; the core's notify stage
// (retryAlerts, on the worker timer) then delivers it like any other undelivered alert.
let db: TestDatabase
let adminUrl: string

beforeAll(async () => {
  await requireDatabase()
  db = await createTestDatabase()
  const url = new URL(databaseUrl)
  url.pathname = `/${db.name}`
  adminUrl = url.toString()
})

afterAll(async () => {
  await db?.drop()
})

const alerts = async () =>
  (
    await db.admin.query<{ brand_id: string | null; severity: number; kind: string; ref: string }>(
      "select brand_id, severity, kind, detail ->> 'ref' as ref from app.alert where kind = 'backup_failed'",
    )
  ).rows

describe('ops alert', () => {
  it('raises one severity 1 platform alert that the core will deliver', async () => {
    expect(ALERT_KINDS).toContain('backup_failed')
    const result = await raiseOpsAlert(adminUrl, 'backup_failed')
    expect(result.created).toBe(true)
    expect(await alerts()).toEqual([
      { brand_id: null, severity: 1, kind: 'backup_failed', ref: 'backup_failed' },
    ])
    // The core's retry stage reads app.undelivered_alerts: a new alert is due at once.
    const due = await db.admin.query<{ kind: string }>(
      "select kind from app.undelivered_alerts(50, now()) where kind = 'backup_failed'",
    )
    expect(due.rowCount).toBe(1)
  })

  it('raising it again while it is unresolved creates nothing', async () => {
    const again = await raiseOpsAlert(adminUrl, 'backup_failed')
    expect(again.created).toBe(false)
    expect(await alerts()).toHaveLength(1)
  })

  it('refuses a kind it does not know, before touching the database', async () => {
    await expect(raiseOpsAlert('postgres://nobody@127.0.0.1:1/none', 'drop_everything')).rejects.toThrow(
      /Unknown alert kind/,
    )
  })

  it('reads the address from the environment and refuses a placeholder, never printing it', async () => {
    await expect(alertFromEnv({}, ['backup_failed'])).rejects.toThrow(/ADMIN_DATABASE_URL/)
    const placeholder = 'postgres://postgres:CHANGE_ME_secretish@postgres:5432/mkt'
    let message = ''
    try {
      await alertFromEnv({ ADMIN_DATABASE_URL: placeholder }, ['backup_failed'])
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/ADMIN_DATABASE_URL.*CHANGE_ME/)
    expect(message).not.toContain('secretish')
    await expect(alertFromEnv({ ADMIN_DATABASE_URL: adminUrl }, [])).rejects.toThrow(/Usage: alert/)
  })
})
