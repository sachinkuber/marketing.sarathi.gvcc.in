import type { PoolClient } from '@mkt/db'

// Whether a research run is still going: its state says so, or any of its jobs is still alive (not finished,
// cancelled or dead). A dead job can fail its run while its siblings keep going, so the state alone is not
// enough. Starting research and deleting a document both refuse while this is true.
export async function researchRunIsOpen(client: PoolClient, runId: string): Promise<boolean> {
  const run = await client.query<{ state: string }>('select state from app.run where id = $1', [runId])
  if (run.rows[0]?.state === 'running' || run.rows[0]?.state === 'created') return true
  const alive = await client.query(
    `select 1 from app.job_input i join app.job_control c on c.job_id = i.job_id
      where i.run_id = $1 and i.finished_at is null and not c.cancel_requested and c.dead_at is null
      limit 1`,
    [runId],
  )
  return alive.rows.length > 0
}
