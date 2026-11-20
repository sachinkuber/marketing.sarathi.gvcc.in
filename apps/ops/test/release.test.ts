import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { requireDatabase } from '@mkt/test-support'
import { agentFilesHash, setsHash } from '@mkt/db'
import { createTestDatabase, type TestDatabase } from '@mkt/db/testing'
import { Refused, releaseAgent } from '../src/release.ts'

const SUMMARY_DIR = new URL('../../../agents/summary/', import.meta.url).pathname
const OWNER = 'owner@release.test'
const dirs: string[] = []

// A copy of agents/summary at a version the database does not know yet.
function agentDir(version = 3): string {
  const parent = mkdtempSync(join(tmpdir(), 'release-'))
  dirs.push(parent)
  const dir = join(parent, 'summary')
  cpSync(SUMMARY_DIR, dir, { recursive: true })
  const file = join(dir, 'definition.json')
  const def = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  def['version'] = version
  writeFileSync(file, JSON.stringify(def))
  return dir
}

let db: TestDatabase
let ownerId: string
beforeAll(async () => {
  await requireDatabase()
  db = await createTestDatabase()
  const u = await db.admin.query<{ id: string }>(
    `insert into auth."user" (name, email, "emailVerified") values ('o', $1, true) returning id`,
    [OWNER],
  )
  ownerId = u.rows[0]!.id
  await db.admin.query('insert into app.platform_owner (user_id) values ($1)', [ownerId])
  await db.admin.query(
    `insert into auth."user" (name, email, "emailVerified") values ('n', 'plain@release.test', true)`,
  )
  await db.admin.query(
    `select app.create_brand('Brand A', 'brand-a'), app.create_brand('Brand B', 'brand-b')`,
  )
}, 120_000)
afterAll(async () => {
  await db?.drop()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
beforeEach(async () => {
  await db.admin.query(`delete from app.agent_definition_version where agent = 'summary' and version >= 3`)
  await db.admin.query(
    `update app.agent_definition_version set live = true where agent = 'summary' and version = 2`,
  )
  await db.admin.query('delete from app.evaluation_result')
  await db.admin.query('delete from app.evaluation_run')
})

async function recordRun(dir: string, passed: boolean, brandSlug?: string, version = 3): Promise<string> {
  const r = await db.admin.query<{ id: string }>(
    `insert into app.evaluation_run
       (agent, version, files_hash, sets_hash, model, finished_at, passed, subject_brand_id)
     values ('summary', $1, $2, $3, 'claude-sonnet-5-5', now(), $4,
             (select id from app.brand where slug = $5)) returning id`,
    [version, agentFilesHash(dir), setsHash(dir), passed, brandSlug ?? null],
  )
  return r.rows[0]!.id
}
function addBrandFolder(dir: string, slug: string): void {
  mkdirSync(join(dir, 'eval', slug), { recursive: true })
  writeFileSync(join(dir, 'eval', slug, 'c1.json'), '{}')
}
const release = (dir: string, byEmail = OWNER) =>
  releaseAgent({ adminUrl: db.urlFor('migration'), agentDir: dir, byEmail })
const liveRows = async () =>
  (
    await db.admin.query<{ version: number; released_by: string | null; evaluation_run_id: string | null }>(
      `select version, released_by, evaluation_run_id from app.agent_definition_version
        where agent = 'summary' and live`,
    )
  ).rows

describe('releaseAgent', () => {
  it('refuses without a passing run, saying how to fix it', async () => {
    const dir = agentDir()
    await expect(release(dir)).rejects.toThrow(Refused)
    await expect(release(dir)).rejects.toThrow(/no passing evaluation run for summary v3.*npm run eval/)
    await recordRun(dir, false)
    await expect(release(dir)).rejects.toThrow(/no passing evaluation run/)
  })

  it('refuses an agent folder with no evaluation cases', async () => {
    const dir = agentDir()
    rmSync(join(dir, 'eval'), { recursive: true, force: true })
    await expect(release(dir)).rejects.toThrow(/no passing evaluation run/)
  })

  it('refuses when a file changed after the run', async () => {
    const dir = agentDir()
    await recordRun(dir, true)
    appendFileSync(join(dir, 'system.md'), '\nOne more rule.\n')
    await expect(release(dir)).rejects.toThrow(/no passing evaluation run/)
  })

  it('refuses when the evaluation set changed after the run', async () => {
    const dir = agentDir()
    await recordRun(dir, true)
    appendFileSync(join(dir, 'eval', 'shared', 'extra.json'), '{}')
    await expect(release(dir)).rejects.toThrow(/no passing evaluation run/)
  })

  it('refuses a definition that does not parse', async () => {
    const dir = agentDir()
    appendFileSync(join(dir, 'definition.json'), 'garbage')
    await expect(release(dir)).rejects.toThrow(Refused)
  })

  it('refuses an email that is not a platform owner, and an unknown one', async () => {
    const dir = agentDir()
    await recordRun(dir, true)
    await expect(release(dir, 'plain@release.test')).rejects.toThrow(/not a platform owner/)
    await expect(release(dir, 'nobody@release.test')).rejects.toThrow(/not a platform owner/)
    expect((await liveRows())[0]?.version).toBe(2)
  })

  it('releases with a passing run: one live row, released_by set, audited', async () => {
    const dir = agentDir()
    const runId = await recordRun(dir, true)
    const out = await release(dir)
    expect(out).toEqual({ agent: 'summary', version: 3, evaluationRunId: runId })
    const live = await liveRows()
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ version: 3, released_by: ownerId, evaluation_run_id: runId })
    const row = await db.admin.query<{ model: string; effort: string; files_hash: string }>(
      `select model, effort, files_hash from app.agent_definition_version where agent = 'summary' and version = 3`,
    )
    expect(row.rows[0]).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'low',
      files_hash: agentFilesHash(dir),
    })
    const audit = await db.admin.query<{ actor_kind: string; actor_id: string; detail: unknown }>(
      `select actor_kind, actor_id, detail from audit.log where action = 'agent.released'`,
    )
    expect(audit.rows).toEqual([
      {
        actor_kind: 'system',
        actor_id: ownerId,
        detail: { agent: 'summary', version: 3, evaluationRunId: runId, evaluationRunIds: [runId] },
      },
    ])
  })

  it('refuses a second release of the same version as already live', async () => {
    const dir = agentDir()
    await recordRun(dir, true)
    await release(dir)
    await expect(release(dir)).rejects.toThrow(/already live/)
    expect(await liveRows()).toHaveLength(1)
  })

  it('matches the owner email without regard to case', async () => {
    const dir = agentDir()
    await recordRun(dir, true)
    await expect(release(dir, 'Owner@Release.TEST')).resolves.toMatchObject({ version: 3 })
  })

  it('refuses a definition whose agent differs from the folder name', async () => {
    const dir = agentDir()
    const file = join(dir, 'definition.json')
    const def = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    def['agent'] = 'other'
    writeFileSync(file, JSON.stringify(def))
    await expect(release(dir)).rejects.toThrow(/names the agent "other" but the folder is "summary"/)
  })

  it('names the failed case ids of the newest failing run, never their content', async () => {
    const dir = agentDir()
    const runId = await recordRun(dir, false)
    await db.admin.query(
      `insert into app.evaluation_result (run_id, case_id, hostile, passed, checks, input_tokens, output_tokens)
       values ($1, 'bad-case', true, false, '[{"text":"SECRET CONTENT"}]', 1, 1),
              ($1, 'good-case', false, true, '[]', 1, 1)`,
      [runId],
    )
    const message = await release(dir).then(
      () => '',
      (e: Error) => e.message,
    )
    expect(message).toContain('bad-case')
    expect(message).not.toContain('good-case')
    expect(message).not.toContain('SECRET')
  })

  it('refuses a shared-only passing run when a brand folder exists, naming the brand and the command', async () => {
    const dir = agentDir()
    addBrandFolder(dir, 'brand-a')
    await recordRun(dir, true)
    const message = await release(dir).then(
      () => '',
      (e: Error) => e.message,
    )
    expect(message).toContain('brand-a')
    expect(message).toContain('npm run eval -- --agent summary --brand brand-a')
    expect(await liveRows()).toMatchObject([{ version: 2 }])
  })

  it('refuses a brand folder with no matching brand, even with a passing shared-only run', async () => {
    const dir = agentDir()
    addBrandFolder(dir, 'ghost')
    await recordRun(dir, true)
    await expect(release(dir)).rejects.toThrow(/eval\/ghost\/ has no brand with the slug "ghost"/)
    expect(await liveRows()).toMatchObject([{ version: 2 }])
  })

  it('refuses until every brand folder has a passing run for its own brand', async () => {
    const dir = agentDir()
    addBrandFolder(dir, 'brand-a')
    addBrandFolder(dir, 'brand-b')
    await recordRun(dir, true, 'brand-a')
    await recordRun(dir, true, 'brand-a')
    await expect(release(dir)).rejects.toThrow(/brand brand-b/)
    await expect(release(dir)).rejects.not.toThrow(/brand-a/)
  })

  it('releases when every brand folder has a passing run', async () => {
    const dir = agentDir()
    addBrandFolder(dir, 'brand-a')
    addBrandFolder(dir, 'brand-b')
    const a = await recordRun(dir, true, 'brand-a')
    const b = await recordRun(dir, true, 'brand-b')
    const out = await release(dir)
    expect(out.version).toBe(3)
    expect(out.evaluationRunId).toBe(a)
    expect(await liveRows()).toMatchObject([{ version: 3, evaluation_run_id: a }])
    const audit = await db.admin.query<{ detail: { evaluationRunId: string; evaluationRunIds: string[] } }>(
      `select detail from audit.log where action = 'agent.released' and detail->>'evaluationRunId' = $1`,
      [a],
    )
    expect(audit.rows[0]?.detail.evaluationRunId).toBe(a)
    expect(audit.rows[0]?.detail.evaluationRunIds).toEqual([a, b])
  })

  it('a run for one brand does not stand in for the no-brand case', async () => {
    const dir = agentDir()
    await recordRun(dir, true, 'brand-a')
    await expect(release(dir)).rejects.toThrow(/no passing evaluation run/)
  })

  it('two concurrent releases: one wins, the other refuses plainly', async () => {
    const dir = agentDir()
    await recordRun(dir, true)
    const results = await Promise.allSettled([release(dir), release(dir)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason).toBeInstanceOf(Refused)
    expect(await liveRows()).toHaveLength(1)
  })

  it('re-activates a version row that is not live, keeping its files_hash', async () => {
    const dir = agentDir()
    await db.admin.query(
      `insert into app.agent_definition_version (agent, version, model, effort, files_hash)
       values ('summary', 3, 'old', 'low', $1)`,
      [agentFilesHash(dir)],
    )
    const runId = await recordRun(dir, true)
    await release(dir)
    const rows = await db.admin.query(
      `select evaluation_run_id, live, files_hash from app.agent_definition_version where agent = 'summary' and version = 3`,
    )
    expect(rows.rows).toEqual([{ evaluation_run_id: runId, live: true, files_hash: agentFilesHash(dir) }])
    expect(await liveRows()).toHaveLength(1)
  })

  it('refuses a version row recorded with other files, and leaves it untouched', async () => {
    const dir = agentDir()
    await db.admin.query(
      `insert into app.agent_definition_version (agent, version, model, effort, files_hash)
       values ('summary', 3, 'old', 'low', 'other-files')`,
    )
    await recordRun(dir, true)
    await expect(release(dir)).rejects.toThrow(
      /summary v3 was recorded with other files; raise "version" in definition\.json and run the evaluation again/,
    )
    const rows = await db.admin.query(
      `select live, files_hash, model from app.agent_definition_version where agent = 'summary' and version = 3`,
    )
    expect(rows.rows).toEqual([{ live: false, files_hash: 'other-files', model: 'old' }])
    expect(await liveRows()).toMatchObject([{ version: 2 }])
  })

  it('refuses a live version row recorded with other files, with the same message', async () => {
    const dir = agentDir()
    await db.admin.query(
      `update app.agent_definition_version set live = false where agent = 'summary' and live`,
    )
    await db.admin.query(
      `insert into app.agent_definition_version (agent, version, model, effort, files_hash, live)
       values ('summary', 3, 'old', 'low', 'other-files', true)`,
    )
    await recordRun(dir, true)
    await expect(release(dir)).rejects.toThrow(/was recorded with other files/)
    const rows = await db.admin.query(
      `select files_hash from app.agent_definition_version where agent = 'summary' and version = 3`,
    )
    expect(rows.rows).toEqual([{ files_hash: 'other-files' }])
  })
})

describe('release command exit codes', () => {
  const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url))
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [MAIN, 'release', ...args], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  it('refuses bad arguments, an unknown agent and a missing environment with 2', () => {
    expect(run(['--nope']).code).toBe(2)
    expect(run(['--agent', 'nothing', '--by', 'a@b.c'], { ADMIN_DATABASE_URL: 'x' }).code).toBe(2)
    expect(run(['--agent', 'summary', '--by', 'a@b.c']).code).toBe(2)
  })
  it('exits 3 when the database is down, printing no address or password', () => {
    const r = run(['--agent', 'summary', '--by', 'a@b.c'], {
      ADMIN_DATABASE_URL: 'postgres://u:pw-secret@127.0.0.1:1/db',
    })
    expect(r.code).toBe(3)
    expect(r.out).not.toContain('pw-secret')
  })
})
