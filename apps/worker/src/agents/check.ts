import { z } from 'zod'
import type { JobHandler } from '../runner.ts'

const input = z.strictObject({ versionId: z.string().min(1).max(200) })

// The placeholder check makes no model call. The rule runs in the core (it reads the stored version); this
// handler only carries the version id there as the job's result.
export const checkHandler: JobHandler = async (ctx) => {
  const { versionId } = input.parse(ctx.input)
  return { type: 'placeholder_check.v1', result: { versionId } }
}
