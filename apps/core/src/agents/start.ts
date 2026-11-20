import { withBrand, type Pool } from '@mkt/db'
import { briefSchema } from '@mkt/shared'
import { AppError } from '../errors.ts'
import { createJob, createRun, type JobsDeps } from '../jobs/service.ts'

// Who starts the run: a person (the route), or the system (the load-test injector, apps/core/src/load-inject.ts).
export type RunStarter = { userId: string } | { system: 'load_test' }

export const SUMMARY_AGENT = 'summary'
export const SUMMARY_RESULT_TYPE = 'summary.v1'

// Starts the summary agent on a brief: the run, its first job and the audit entry commit together or not at
// all. The brief is checked here too (the route checks it first), so no caller can start a run on a brief the
// agent's contract refuses. The audit entry carries the brief's length, never its text. The first job is
// interactive (a person is waiting), except for the load test's production-class jobs (spec 17, test 41).
export async function startSummaryRun(
  pool: Pool,
  deps: Pick<JobsDeps, 'queue' | 'backlogLimit' | 'audit'>,
  input: {
    brandId: string
    brief: string
    actor: RunStarter
    jobClass?: 'interactive' | 'production'
  },
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
      startedByKind: 'userId' in input.actor ? 'user' : 'system',
      startedById: 'userId' in input.actor ? input.actor.userId : null,
    })
    const jobId = await createJob(client, deps, input.brandId, {
      runId,
      jobClass: input.jobClass ?? 'interactive',
      input: { brief },
      expectedResultType: SUMMARY_RESULT_TYPE,
      agent: SUMMARY_AGENT,
    })
    await deps.audit.record(
      {
        action: 'agent.run_started',
        ...('userId' in input.actor
          ? { actor: input.actor.userId }
          : { actor: null, actorKind: 'system' as const }),
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
