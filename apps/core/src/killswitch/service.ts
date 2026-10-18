import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'

export type KillScope = 'brand' | 'channel' | 'agent'

export interface KillSwitch {
  id: string
  scope: KillScope
  target: string | null
  active: boolean
  setBy: string
  setAt: Date
}

export interface KillSwitchDeps {
  audit: AuditSink
  // Called inside the release transaction with the ids of the jobs whose held flag was cleared: the service
  // passes releaseHeldJobs (killswitch/release.ts), which applies held results and sends the jobs again.
  // The default does nothing.
  afterRelease?: (client: PoolClient, unheldJobIds: string[]) => Promise<void>
}

interface Input {
  brandId: string
  scope: KillScope
  target: string | null
  actor: string
}

interface Row {
  id: string
  scope: KillScope
  target: string | null
  active: boolean
  set_by: string
  set_at: Date
}

const COLUMNS = 'id, scope, target, active, set_by, set_at'
const shape = (r: Row): KillSwitch => ({
  id: r.id,
  scope: r.scope,
  target: r.target,
  active: r.active,
  setBy: r.set_by,
  setAt: r.set_at,
})

// hold_brand_jobs takes the agent name or null for every job of the brand.
async function hold(
  client: PoolClient,
  brandId: string,
  agent: string | null,
  on: boolean,
): Promise<string[]> {
  const { rows } = await client.query<{ hold_brand_jobs: string }>('select app.hold_brand_jobs($1, $2, $3)', [
    brandId,
    agent,
    on,
  ])
  return rows.map((r) => r.hold_brand_jobs)
}

// Set and release take the brand row FOR UPDATE first, so they run one at a time per brand (release reads the
// remaining switches, which a concurrent set must not change underneath it), and job creation, which takes the
// same row FOR SHARE (jobs/service.ts createJob), is ordered against them.
async function lockBrand(client: PoolClient, brandId: string): Promise<void> {
  const locked = await client.query('select id from app.brand where id = $1 for update', [brandId])
  if (!locked.rows[0]) throw new AppError(404, 'not_found', 'There is nothing at this address.')
}

export async function listActive(pool: Pool, brandId: string): Promise<KillSwitch[]> {
  return withBrand(pool, brandId, async (client) => {
    const { rows } = await client.query<Row>(
      `select ${COLUMNS} from app.kill_switch where brand_id = $1 and active order by set_at, id`,
      [brandId],
    )
    return rows.map(shape)
  })
}

// Spec 9.2: setting a switch moves the brand's waiting jobs to held. Brand scope holds all of them; agent
// scope holds those of runs of that agent (an agent name that matches no run is simply stored). CHANNEL scope
// is stored, shown and audited but holds nothing: no job carries a channel in phase 1, so there is nothing
// to match. The same switch set twice is returned unchanged and does nothing else.
export async function setSwitch(
  pool: Pool,
  deps: KillSwitchDeps,
  input: Input,
): Promise<{ switch: KillSwitch; held: number; created: boolean }> {
  return withBrand(pool, input.brandId, async (client) => {
    await lockBrand(client, input.brandId)
    const inserted = await client.query<Row>(
      `insert into app.kill_switch (brand_id, scope, target, active, set_by)
       values ($1, $2, $3, true, $4)
       on conflict (brand_id, scope, coalesce(target, '')) where active do nothing
       returning ${COLUMNS}`,
      [input.brandId, input.scope, input.target, input.actor],
    )
    if (!inserted.rows[0]) {
      const existing = await client.query<Row>(
        `select ${COLUMNS} from app.kill_switch
          where brand_id = $1 and scope = $2 and target is not distinct from $3 and active`,
        [input.brandId, input.scope, input.target],
      )
      // Under the brand lock a conflict means a committed active row; if it is somehow gone, ask for a retry
      // rather than failing on a missing row.
      const found = existing.rows[0]
      if (!found) throw new AppError(409, 'conflict', 'The switch changed while it was being set. Try again.')
      return { switch: shape(found), held: 0, created: false }
    }
    const held =
      input.scope === 'channel'
        ? []
        : await hold(client, input.brandId, input.scope === 'agent' ? input.target : null, true)
    await deps.audit.record(
      {
        action: 'killswitch.set',
        actor: input.actor,
        subject: inserted.rows[0].id,
        brandId: input.brandId,
        outcome: 'success',
        detail: { scope: input.scope, target: input.target, held: held.length },
      },
      client,
    )
    return { switch: shape(inserted.rows[0]), held: held.length, created: true }
  })
}

// Releasing returns the jobs to ready, except those another active switch still covers (a brand switch
// covers every job; an agent switch covers its agent's). Sending the freed jobs again and applying their held
// results is `deps.afterRelease`, given the freed ids (killswitch/release.ts).
export async function releaseSwitch(
  pool: Pool,
  deps: KillSwitchDeps,
  input: Input,
): Promise<{ released: boolean; unheldJobIds: string[] }> {
  return withBrand(pool, input.brandId, async (client) => {
    await lockBrand(client, input.brandId)
    const updated = await client.query<{ id: string }>(
      `update app.kill_switch set active = false, released_by = $4, released_at = now()
        where brand_id = $1 and scope = $2 and target is not distinct from $3 and active
        returning id`,
      [input.brandId, input.scope, input.target, input.actor],
    )
    const row = updated.rows[0]
    if (!row) return { released: false, unheldJobIds: [] }

    let unheld: string[] = []
    if (input.scope !== 'channel') {
      // The engine's lock order is job_input first, then job_control (markDead, startAttempt, a result post).
      // hold_brand_jobs updates job_control, and the release hook then locks job_input; so the input rows of
      // every job this release may free are locked here first, in id order, before any job_control row.
      await client.query(
        `select i.job_id from app.job_input i join app.job_control c on c.job_id = i.job_id
          where i.brand_id = $1 and i.finished_at is null and c.dead_at is null and c.held
          order by i.job_id
          for update of i`,
        [input.brandId],
      )
      const remaining = await client.query<{ scope: KillScope; target: string | null }>(
        `select scope, target from app.kill_switch where brand_id = $1 and active and scope in ('brand', 'agent')`,
        [input.brandId],
      )
      if (!remaining.rows.some((r) => r.scope === 'brand')) {
        if (input.scope === 'agent') {
          unheld = await hold(client, input.brandId, input.target, false)
        } else {
          // The brand switch is gone: free everything, then put back what an agent switch still covers.
          unheld = await hold(client, input.brandId, null, false)
          for (const agent of remaining.rows.filter((r) => r.scope === 'agent')) {
            const again = new Set(await hold(client, input.brandId, agent.target, true))
            unheld = unheld.filter((id) => !again.has(id))
          }
        }
      }
    }
    await deps.audit.record(
      {
        action: 'killswitch.released',
        actor: input.actor,
        subject: row.id,
        brandId: input.brandId,
        outcome: 'success',
        detail: { scope: input.scope, target: input.target, unheld: unheld.length },
      },
      client,
    )
    await deps.afterRelease?.(client, unheld)
    return { released: true, unheldJobIds: unheld }
  })
}
