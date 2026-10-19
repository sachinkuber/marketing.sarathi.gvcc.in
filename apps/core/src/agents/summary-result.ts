import { summaryPayload, summaryResultSchema } from '@mkt/shared'
import { createVersion, moveState } from '../content/versions.ts'
import { AppError } from '../errors.ts'
import { createJob, type JobsDeps } from '../jobs/service.ts'
import type { ResultHandler } from '../jobs/results.ts'

export const CHECK_RESULT_TYPE = 'placeholder_check.v1'

// The business effect of a summary.v1 result, inside the core's result transaction (job_input then run locks
// held): the reply is checked again here (the worker's check is not trusted), the item and its first version
// are made in `draft`, the version moves to `in_checks`, and the check job is queued in the same run. A reply
// that fails the contract makes no content at all.
export function summaryResultHandler(deps: Pick<JobsDeps, 'audit' | 'queue' | 'backlogLimit'>): ResultHandler {
  return async (client, ctx) => {
    const parsed = summaryResultSchema.safeParse(ctx.result)
    if (!parsed.success) {
      throw new AppError(422, 'result_invalid', 'The result is not a valid summary.')
    }
    const actor = { kind: 'agent' as const, runId: ctx.runId }
    const item = await client.query<{ id: string }>(
      `insert into app.content_item (brand_id, kind) values ($1, 'summary') returning id`,
      [ctx.brandId],
    )
    const contentItemId = item.rows[0]!.id
    const version = await createVersion(client, deps, {
      brandId: ctx.brandId,
      contentItemId,
      payload: summaryPayload(parsed.data),
      createdBy: actor,
    })
    await moveState(client, deps, version.versionId, 'in_checks', actor)
    const checkJobId = await createJob(client, deps, ctx.brandId, {
      runId: ctx.runId,
      jobClass: 'interactive',
      input: { versionId: version.versionId },
      expectedResultType: CHECK_RESULT_TYPE,
    })
    return { contentItemId, versionId: version.versionId, hash: version.hash, checkJobId }
  }
}
