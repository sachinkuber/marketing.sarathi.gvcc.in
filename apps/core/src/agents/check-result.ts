import { placeholderCheck } from '@mkt/shared'
import { z } from 'zod'
import { moveState } from '../content/versions.ts'
import { AppError } from '../errors.ts'
import type { ResultHandler } from '../jobs/results.ts'
import type { JobsDeps } from '../jobs/service.ts'

const checkResultSchema = z.strictObject({ versionId: z.uuid() })

const invalid = () => new AppError(422, 'result_invalid', 'The result is not a valid check result.')

// The business effect of a placeholder_check.v1 result. The worker only says which version it looked at; the
// rule is applied here, by the core, to the version's stored canonical payload, never to anything the worker
// sends. The result must name the version the job was given. The check is recorded whatever the version's
// state; only a version still in_checks is moved (a newer version may have superseded it meanwhile).
export function checkResultHandler(deps: Pick<JobsDeps, 'audit'>): ResultHandler {
  return async (client, ctx) => {
    const parsed = checkResultSchema.safeParse(ctx.result)
    if (!parsed.success) throw invalid()
    const { versionId } = parsed.data
    const job = await client.query<{ input: { versionId?: unknown } | null }>(
      'select input from app.job_input where job_id = $1',
      [ctx.jobId],
    )
    if (job.rows[0]?.input?.versionId !== versionId) throw invalid()

    const found = await client.query<{ payload_canonical: string }>(
      'select payload_canonical from app.content_version where brand_id = $1 and id = $2',
      [ctx.brandId, versionId],
    )
    const stored = found.rows[0]
    if (!stored) throw invalid()
    const check = placeholderCheck(JSON.parse(stored.payload_canonical) as Record<string, unknown>)

    // The version row is locked (as moveState does) before the state is read, so a supersede cannot slip in
    // between the read and the move.
    const state = await client.query<{ state: string }>(
      'select state from app.content_version_state where content_version_id = $1 for update',
      [versionId],
    )
    await client.query(
      `insert into app.check_result (brand_id, content_version_id, check_name, kind, passed, detail)
       values ($1, $2, 'placeholder_length', 'blocking', $3, $4::jsonb)`,
      [ctx.brandId, versionId, check.passed, JSON.stringify(check.detail)],
    )
    if (state.rows[0]?.state === 'in_checks') {
      await moveState(
        client,
        deps,
        versionId,
        check.passed ? 'awaiting_approval' : 'check_failed',
        { kind: 'agent', runId: ctx.runId },
        'placeholder_check',
      )
    }
    return { passed: check.passed }
  }
}
