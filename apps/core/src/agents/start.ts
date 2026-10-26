import { withBrand, type Pool } from '@mkt/db'
import { briefSchema } from '@mkt/shared'
import { AppError } from '../errors.ts'
import { createJob, createRun, type JobsDeps } from '../jobs/service.ts'

export const SUMMARY_AGENT = 'summary'
export const SUMMARY_RESULT_TYPE = 'summary.v1'

// Starts the summary agent on a brief: the run, its first job and the audit entry commit together or not at
// all. The brief is checked here too (the route checks it first), so no caller can start a run on a brief the
// agent's contract refuses. The audit entry carries the brief's length, never its text.
export async function startSummaryRun(
  pool: Pool,
  deps: JobsDeps,
  input: { brandId: string; brief: string; actor: { userId: string } },
): Promise<{ runId: string; jobId: string }> {
  const parsed = briefSchema.safeParse({ brief: input.brief })
  if (!parsed.success) {
    throw new AppError(
      400,
      'invalid_request',
      'The brief is not valid.',
      parsed.error.issues.map((i) => ({ part: 'body', path: i.path.join('.'), message: i.message })),
    )
  }
  const { brief } = parsed.data
  return withBrand(pool, input.brandId, async (client) => {
    const live = await client.query<{ id: string }>(
      'select id from app.agent_definition_version where agent = $1 and live',
      [SUMMARY_AGENT],
    )
    const definitionVersionId = live.rows[0]?.id
    if (!definitionVersionId) {
      throw new AppError(503, 'agent_unavailable', 'The summary agent has no live definition.')
    }
    const runId = await createRun(client, input.brandId, {
      agent: SUMMARY_AGENT,
      definitionVersionId,
      startedByKind: 'user',
      startedById: input.actor.userId,
    })
    const jobId = await createJob(client, deps, input.brandId, {
      runId,
      jobClass: 'interactive',
      input: { brief },
      expectedResultType: SUMMARY_RESULT_TYPE,
    })
    await deps.audit.record(
      {
        action: 'agent.run_started',
        actor: input.actor.userId,
        brandId: input.brandId,
        subject: runId,
        outcome: 'success',
        detail: { runId, jobId, briefLength: brief.length },
      },
      client,
    )
    return { runId, jobId }
  })
}
