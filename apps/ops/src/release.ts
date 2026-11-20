import { existsSync } from 'node:fs'
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
  const filesHash = agentFilesHash(input.agentDir)
  const sets = setsHash(input.agentDir)

  const client = new pg.Client({ connectionString: input.adminUrl })
  await client.connect()
  try {
    await client.query('begin')
    const owner = await client.query<{ id: string }>(
      `select u.id from auth."user" u join app.platform_owner o on o.user_id = u.id where u.email = $1`,
      [input.byEmail],
    )
    const ownerId = owner.rows[0]?.id
    if (!ownerId) {
      throw new Refused('that email is not a platform owner; release with the owner sign-in email (--by)')
    }

    const run = await client.query<{ id: string }>(
      `select id from app.evaluation_run
        where agent = $1 and version = $2 and files_hash = $3 and sets_hash = $4 and passed = true
        order by finished_at desc nulls last limit 1`,
      [agent, version, filesHash, sets],
    )
    const runId = run.rows[0]?.id
    if (!runId) {
      throw new Refused(
        `no passing evaluation run for ${agent} v${version} with the current files; run \`npm run eval -- --agent ${agent}\` first`,
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
    throw error
  } finally {
    await client.end()
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
