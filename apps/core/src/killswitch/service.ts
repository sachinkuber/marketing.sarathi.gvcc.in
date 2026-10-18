import { withBrand, type Pool, type PoolClient } from '@mkt/db'
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
  // Task 8 (release): called inside the release transaction with the ids of the jobs whose held flag was
  // cleared, so the queue entries that already completed while the job was held can be put back to ready.
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
      return { switch: shape(existing.rows[0]!), held: 0, created: false }
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
// covers every job; an agent switch covers its agent's). Re-enqueueing jobs the queue already completed while
// they were held is not done here: `deps.afterRelease` is where it is added, given the freed ids.
export async function releaseSwitch(
  pool: Pool,
  deps: KillSwitchDeps,
  input: Input,
): Promise<{ released: boolean; unheldJobIds: string[] }> {
  return withBrand(pool, input.brandId, async (client) => {
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
