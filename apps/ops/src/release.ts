import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import pg from 'pg'
import { agentFilesHash, setsHash } from '@mkt/db'
import { loadAgentDefinition, type LoadedAgent } from '@mkt/shared'

// `release --agent <name> --by <email>`: an agent version goes live only when a passing evaluation run exists
// for exactly its current files and its current evaluation set (the columns `eval` records). Exit codes: 0
// released, 2 refused (the message says how to fix it), 3 unexpected error.
export class Refused extends Error {
  override name = 'Refused'
}

export interface ReleaseInput {
  adminUrl: string
  agentDir: string
  byEmail: string
}
export interface ReleaseResult {
  agent: string
  version: number
  evaluationRunId: string
}

export async function releaseAgent(input: ReleaseInput): Promise<ReleaseResult> {
  let loaded: LoadedAgent
  try {
    loaded = loadAgentDefinition(input.agentDir)
  } catch (error) {
    throw new Refused(
      `the agent definition cannot be read: ${error instanceof Error ? error.message : 'unknown problem'}. Fix it and run \`npm run eval\` again`,
    )
  }
  const { agent, version, model, effort } = loaded.definition
  const folder = basename(input.agentDir.replace(/\/+$/, ''))
  if (agent !== folder) {
    throw new Refused(
      `definition.json names the agent "${agent}" but the folder is "${folder}"; make them the same`,
    )
  }
  const filesHash = agentFilesHash(input.agentDir)
  const sets = setsHash(input.agentDir)
  // A run without --brand tests eval/shared only, so each brand folder needs a run of its own.
  const evalDir = join(input.agentDir, 'eval')
  const brandSlugs = existsSync(evalDir)
    ? readdirSync(evalDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'shared')
        .map((e) => e.name)
        .sort()
    : []

  const client = new pg.Client({ connectionString: input.adminUrl })
  try {
    await client.connect()
    await client.query('begin')
    // A concurrent release of the same agent waits here, then sees the first one's result and refuses plainly.
    await client.query(`select pg_advisory_xact_lock(hashtext('agent_release:' || $1))`, [agent])
    const owner = await client.query<{ id: string }>(
      `select u.id from auth."user" u join app.platform_owner o on o.user_id = u.id
        where lower(u.email) = lower($1)`,
      [input.byEmail],
    )
    const ownerId = owner.rows[0]?.id
    if (!ownerId) {
      throw new Refused('that email is not a platform owner; release with the owner sign-in email (--by)')
    }

    // subject_brand_id is the id of the brand the slug names, as `eval --brand` records it. A folder whose
    // slug names no brand can never have a run of its own, so it is refused before any run is looked at.
    const targets: { slug: string | null; brandId: string | null }[] = []
    for (const slug of brandSlugs) {
      const brand = await client.query<{ id: string }>('select id from app.brand where slug = $1', [slug])
      const brandId = brand.rows[0]?.id
      if (!brandId) {
        throw new Refused(
          `eval/${slug}/ has no brand with the slug "${slug}"; rename the folder or create the brand`,
        )
      }
      targets.push({ slug, brandId })
    }
    if (targets.length === 0) targets.push({ slug: null, brandId: null })
    // brandId null means the no-brand run (subject_brand_id is null); otherwise it must be exactly that brand.
    const subjectMatches = `(($5::uuid is null and r.subject_brand_id is null) or r.subject_brand_id = $5::uuid)`

    const missing: (string | null)[] = []
    let runId: string | undefined
    let failedCases: string[] = []
    for (const { slug, brandId } of targets) {
      const run = await client.query<{ id: string }>(
        `select r.id from app.evaluation_run r
          where r.agent = $1 and r.version = $2 and r.files_hash = $3 and r.sets_hash = $4 and r.passed = true
            and ${subjectMatches}
          order by r.finished_at desc nulls last limit 1`,
        [agent, version, filesHash, sets, brandId],
      )
      if (run.rows[0]) {
        runId ??= run.rows[0].id
        continue
      }
      missing.push(slug)
      if (failedCases.length === 0) {
        const failed = await client.query<{ case_id: string }>(
          `select x.case_id from app.evaluation_result x
            where x.run_id = (
              select r.id from app.evaluation_run r
               where r.agent = $1 and r.version = $2 and r.files_hash = $3 and r.sets_hash = $4
                 and r.passed is not null and ${subjectMatches}
               order by r.finished_at desc nulls last limit 1)
              and not x.passed
            order by x.case_id limit 10`,
          [agent, version, filesHash, sets, brandId],
        )
        failedCases = failed.rows.map((r) => r.case_id)
      }
    }
    if (missing.length > 0 || !runId) {
      const fixes = missing
        .map((slug) => `npm run eval -- --agent ${agent}${slug ? ` --brand ${slug}` : ''}`)
        .join(' ; ')
      const brands = missing.filter((slug): slug is string => slug !== null)
      throw new Refused(
        `no passing evaluation run for ${agent} v${version} with the current files` +
          (brands.length > 0 ? ` and cases for brand ${brands.join(', ')}` : '') +
          (failedCases.length > 0 ? `; the newest run failed these cases: ${failedCases.join(', ')}` : '') +
          `; run \`${fixes}\` first`,
      )
    }

    const existing = await client.query<{ live: boolean }>(
      'select live from app.agent_definition_version where agent = $1 and version = $2 for update',
      [agent, version],
    )
    if (existing.rows[0]?.live) throw new Refused(`${agent} v${version} is already live; nothing to do`)

    await client.query('update app.agent_definition_version set live = false where agent = $1 and live', [
      agent,
    ])
    const columns = [agent, version, model, effort, filesHash, ownerId, runId]
    if (existing.rowCount) {
      await client.query(
        `update app.agent_definition_version
            set model = $3, effort = $4, files_hash = $5, live = true, released_by = $6, released_at = now(),
                evaluation_run_id = $7
          where agent = $1 and version = $2`,
        columns,
      )
    } else {
      await client.query(
        `insert into app.agent_definition_version
           (agent, version, model, effort, files_hash, live, released_by, released_at, evaluation_run_id)
         values ($1, $2, $3, $4, $5, true, $6, now(), $7)`,
        columns,
      )
    }
    await client.query(
      `select audit.append(null, 'system'::app.actor_kind, $1::uuid, 'agent.released', 'success', $2, $3::jsonb)`,
      [ownerId, `${agent}@${version}`, JSON.stringify({ agent, version, evaluationRunId: runId })],
    )
    await client.query('commit')
    return { agent, version, evaluationRunId: runId }
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    // The one-live-row index, if another release got in anyway.
    if ((error as { code?: string }).code === '23505') {
      throw new Refused(`another release of ${agent} changed the live version; check it and try again`)
    }
    throw error
  } finally {
    await client.end().catch(() => undefined)
  }
}

export async function releaseFromEnv(
  env: Record<string, string | undefined>,
  args: string[],
): Promise<number> {
  let values: { agent?: string; by?: string }
  try {
    values = parseArgs({
      args,
      options: { agent: { type: 'string' }, by: { type: 'string' } },
      strict: true,
    }).values
  } catch {
    console.error('usage: release --agent <name> --by <owner email>')
    return 2
  }
  const { agent, by } = values
  if (!agent || !by || !/^[a-z][a-z_]{1,39}$/.test(agent)) {
    console.error('usage: release --agent <name> --by <owner email>')
    return 2
  }
  const agentDir = fileURLToPath(new URL(`../../../agents/${agent}/`, import.meta.url))
  if (!existsSync(agentDir)) {
    console.error('unknown agent: no folder under agents/')
    return 2
  }
  const adminUrl = env['ADMIN_DATABASE_URL']
  if (!adminUrl) {
    console.error('ADMIN_DATABASE_URL must be set')
    return 2
  }
  if (adminUrl.includes('CHANGE_ME')) {
    console.error('ADMIN_DATABASE_URL still contains CHANGE_ME')
    return 2
  }
  try {
    const out = await releaseAgent({ adminUrl, agentDir, byEmail: by })
    console.log(JSON.stringify({ event: 'agent_released', ...out }))
    return 0
  } catch (error) {
    if (error instanceof Refused) {
      console.error(error.message)
      return 2
    }
    console.error(`release failed (${error instanceof Error ? error.name : 'error'})`)
    return 3
  }
}
