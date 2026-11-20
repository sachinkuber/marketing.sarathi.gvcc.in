import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TestDatabase } from '@mkt/db/testing'
import { createQueueTestDatabase } from '@mkt/queue/testing'
import { databaseUrl, requireDatabase } from '@mkt/test-support'
import { parseDrillFile } from '../src/restore-check.ts'

// Acceptance test 40 on the development database: a database seeded the way the drill is seeded before a
// backup, dumped with pg_dump --format=custom and restored with pg_restore as restore.sh restores it (the same
// flags, run by the database server's own PostgreSQL 17 tools through COPY ... TO PROGRAM, since the Node image
// has none), into a new empty database. restore-check then runs on the copy, as a child process, as the runbook
// runs it. The roles are the cluster's own (shared by every test database), with the development passwords.
// The encrypted round trip through backup.sh and restore.sh is infra/prod/test/backup.test.mjs's.

const SCRIPT = fileURLToPath(new URL('../src/restore-check.ts', import.meta.url))
const ADMIN = new URL(databaseUrl)
const secret = () => randomBytes(32).toString('hex')
const SECRETS = {
  AUTH_SECRET: secret(),
  WORKER_SECRET: secret(),
  ATTEMPT_TOKEN_SECRET: secret(),
  TRIGGER_SECRET: secret(),
  PUBLIC_ORIGIN: 'https://drill.example.test',
}
const ROLE_PASSWORDS = {
  MKT_APP_PASSWORD: 'dev_only_app',
  MKT_AUDIT_WRITER_PASSWORD: 'dev_only_audit_writer',
  MKT_QUEUE_PASSWORD: 'dev_only_queue',
  MKT_OWNER_VIEW_PASSWORD: 'dev_only_owner_view',
}

// The superuser's address for a database, with no password (restore-check refuses one in its arguments).
function target(database: string): string {
  const url = new URL(databaseUrl)
  url.password = ''
  url.pathname = `/${database}`
  return url.toString()
}

async function superuser<T>(fn: (client: pg.Client) => Promise<T>, database?: string): Promise<T> {
  const url = new URL(databaseUrl)
  if (database) url.pathname = `/${database}`
  const client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? '', PGPASSWORD: decodeURIComponent(ADMIN.password), ...env },
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
  })
}

let source: TestDatabase
let dir: string
let drill: Record<string, string>
const copies: string[] = []

// A backup of the source restored into a new, empty database: pg_dump --format=custom, then pg_restore with
// restore.sh's flags, by the server's own tools (as the superuser, over the server's local socket).
async function backupAndRestore(): Promise<string> {
  const copy = `${source.name}_r${copies.length + 1}`
  copies.push(copy)
  await superuser((c) => c.query(`create database ${copy}`))
  const file = `/tmp/${copy}.dump`
  const user = decodeURIComponent(ADMIN.username)
  const script = [
    `pg_dump -U ${user} --format=custom --no-password -f ${file} ${source.name}`,
    `pg_restore -U ${user} --exit-on-error --single-transaction --no-password --dbname ${copy} ${file}`,
  ].join(' && ')
  await superuser((c) => c.query(`copy (select 1) to program '${script}; rc=$?; rm -f ${file}; exit $rc'`))
  return copy
}

const checkEnv = () => ({ ...SECRETS, ...ROLE_PASSWORDS, ...drill })

describe('the restore drill (acceptance test 40)', () => {
  beforeAll(async () => {
    await requireDatabase()
    dir = mkdtempSync(join(tmpdir(), 'mkt-drill-'))
    source = await createQueueTestDatabase()
    // Prices and a rate for the stand-in model's usage, as the stack test enters them.
    await source.admin
      .query(`insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, source)
        values ('claude-sonnet-5-5', current_date - 30, 2000000, 10000000, 100000, 2500000, 'test');
      select app.record_fx_rate(current_date - 1, 83500000, 'test');`)
    const seed = () =>
      run(['seed', '--target', target(source.name)], {
        AUTH_SECRET: SECRETS.AUTH_SECRET,
        PUBLIC_ORIGIN: SECRETS.PUBLIC_ORIGIN,
        RESTORE_DRILL_FILE: join(dir, 'drill.env'),
      })
    const readDrill = () => parseDrillFile(readFileSync(join(dir, 'drill.env'), 'utf8'))
    const seeded = await seed()
    expect(seeded.out).toContain('"event":"restore_drill_seeded"')
    expect(seeded.code).toBe(0)
    const first = readDrill()
    expect(Object.keys(first).sort()).toEqual([
      'RESTORE_DRILL_EMAIL',
      'RESTORE_DRILL_JOB_ID',
      'RESTORE_DRILL_LIVE_DATABASE',
      'RESTORE_DRILL_PASSWORD',
      'RESTORE_DRILL_TOTP_SECRET',
    ])
    // A second seed, as before a later drill: same user and secrets, a new waiting job.
    const again = await seed()
    expect(again.code).toBe(0)
    drill = readDrill()
    expect(drill.RESTORE_DRILL_JOB_ID).not.toBe(first.RESTORE_DRILL_JOB_ID)
    expect({ ...drill, RESTORE_DRILL_JOB_ID: '' }).toEqual({ ...first, RESTORE_DRILL_JOB_ID: '' })
    expect(statSync(join(dir, 'drill.env')).mode & 0o777).toBe(0o600)
    for (const out of [seeded.out, again.out]) {
      expect(out).not.toContain(drill.RESTORE_DRILL_PASSWORD)
      expect(out).not.toContain(drill.RESTORE_DRILL_TOTP_SECRET)
    }
  }, 120_000)

  afterAll(async () => {
    for (const copy of copies) {
      await superuser((c) => c.query(`drop database if exists ${copy} with (force)`)).catch(() => undefined)
    }
    await source?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('restore-check passes on a fresh backup of a seeded database and fails when one audit row is altered after restore', async () => {
    const clean = await backupAndRestore()
    const altered = await backupAndRestore()

    const passed = await run(['--target', target(clean)], checkEnv())
    expect(passed.out.trim().split('\n')).toEqual([
      'PASS sign-in with password and second factor',
      'PASS a job waiting in the backup finishes after a worker starts',
      'PASS audit chains verify',
      'PASS brand document restored with its checksum',
      'PASS isolation tests 1 to 6',
    ])
    expect(passed.code).toBe(0)

    // One entry's detail changed in place, its hash left as it was (as the superuser, past the log's triggers).
    await superuser(async (c) => {
      await c.query(`set session_replication_role = replica`)
      const r = await c.query(
        `update audit.log set detail = '{"altered": true}' where id = (select id from audit.log order by at limit 1)`,
      )
      expect(r.rowCount).toBe(1)
    }, altered)
    const failed = await run(['--target', target(altered)], checkEnv())
    expect(failed.out).toMatch(/^FAIL audit chains verify: 1 finding\(s\) \(broken_chain\)/m)
    expect(failed.out).toContain('PASS sign-in with password and second factor')
    expect(failed.code).toBe(1)

    // Nothing secret reaches the output: no password, secret, second-factor secret or address.
    for (const out of [passed.out, failed.out]) {
      for (const value of [...Object.values(SECRETS).slice(0, 4), ...Object.values(ROLE_PASSWORDS)]) {
        expect(out).not.toContain(value)
      }
      expect(out).not.toContain(drill.RESTORE_DRILL_PASSWORD)
      expect(out).not.toContain(drill.RESTORE_DRILL_TOTP_SECRET)
      expect(out).not.toContain(decodeURIComponent(ADMIN.password))
      expect(out).not.toContain('postgres://')
    }
  }, 900_000)

  it('refuses a target address that carries a password, without printing it', async () => {
    const url = new URL(target(source.name))
    url.password = 'not-a-real-password'
    const refused = await run(['--target', url.toString()], checkEnv())
    expect(refused.code).toBe(2)
    expect(refused.out).toContain('"event":"restore_check_refused"')
    expect(refused.out).not.toContain('not-a-real-password')
  })

  // What the live database holds that a drill run would change: audit entries, sessions, and the drill jobs'
  // queue states.
  const liveState = async () =>
    (
      await source.admin.query(
        `select (select count(*) from audit.log)::int as audit, (select count(*) from auth.session)::int as sessions,
                (select string_agg(q.state::text, ',' order by q.id) from pgboss.job q
                   join app.job_input i on i.job_id = q.id) as jobs,
                (select count(*) from pgboss.job)::int as queued`,
      )
    ).rows[0]

  it('refuses the live database the drill was seeded on, and the live service name, before starting anything', async () => {
    const before = await liveState()
    const live = await run(['--target', target(source.name)], checkEnv())
    expect(live.code).toBe(2)
    expect(live.out).toContain('"event":"restore_check_refused"')
    expect(live.out).toContain('the live database the drill was seeded on')
    expect(live.out).not.toMatch(/^(PASS|FAIL) /m)
    // Nothing ran on it: no sign-in, no worker, no test-6 job.
    expect(await liveState()).toEqual(before)

    const byName = await run(['--target', 'postgres://postgres@postgres:5432/mkt'], checkEnv())
    expect(byName.code).toBe(2)
    expect(byName.out).toContain('the target is the live database service')
  })

  it('cancel-live cancels the drill jobs waiting on the live database, once, after the backup was taken', async () => {
    const drillJobs = async () =>
      (
        await source.admin.query(
          `select q.state::text as queue, r.state::text as run from app.job_input i
             join pgboss.job q on q.id = i.job_id join app.run r on r.id = i.run_id
             join app.brand b on b.id = i.brand_id where b.slug like 'restore-drill-%' order by q.id`,
        )
      ).rows
    // The two seeds' jobs wait.
    expect(await drillJobs()).toEqual([
      { queue: 'created', run: 'running' },
      { queue: 'created', run: 'running' },
    ])
    const cancelled = await run(['cancel-live', '--target', target(source.name)], {})
    expect(cancelled.out).toContain('{"event":"restore_drill_cancelled","jobs":2}')
    expect(cancelled.code).toBe(0)
    expect(await drillJobs()).toEqual([
      { queue: 'cancelled', run: 'cancelled' },
      { queue: 'cancelled', run: 'cancelled' },
    ])
    const audited = await source.admin.query(
      `select count(*)::int as n from audit.log where action = 'jobs.cancelled' and detail->>'reason' = 'restore_drill'`,
    )
    expect(audited.rows[0].n).toBe(2)
    // Again: nothing left to cancel.
    const again = await run(['cancel-live', '--target', target(source.name)], {})
    expect(again.out).toContain('{"event":"restore_drill_cancelled","jobs":0}')
  })

  it('unseed removes the drill user, so a lost drill file can be replaced by a new seed', async () => {
    const unseeded = await run(['unseed', '--target', target(source.name)], {})
    expect(unseeded.out).toContain('{"event":"restore_drill_unseeded","removed":true,"cancelled":0}')
    expect(unseeded.code).toBe(0)
    const left = await source.admin.query(`select count(*)::int as n from auth."user" where email = $1`, [
      drill.RESTORE_DRILL_EMAIL,
    ])
    expect(left.rows[0].n).toBe(0)
    const file = join(dir, 'drill-2.env')
    const reseeded = await run(['seed', '--target', target(source.name)], {
      AUTH_SECRET: SECRETS.AUTH_SECRET,
      PUBLIC_ORIGIN: SECRETS.PUBLIC_ORIGIN,
      RESTORE_DRILL_FILE: file,
    })
    expect(reseeded.code).toBe(0)
    expect(parseDrillFile(readFileSync(file, 'utf8')).RESTORE_DRILL_PASSWORD).not.toBe(
      drill.RESTORE_DRILL_PASSWORD,
    )
  })
})
