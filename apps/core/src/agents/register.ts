import type { ResultHandlers } from '../jobs/results.ts'
import type { JobsDeps } from '../jobs/service.ts'
import { checkResultHandler } from './check-result.ts'
import { CHECK_RESULT_TYPE, summaryResultHandler } from './summary-result.ts'
import { SUMMARY_RESULT_TYPE } from './start.ts'

// The result types of the summary agent and the handlers the core applies them with.
export function registerSummaryHandlers(
  results: ResultHandlers,
  deps: Pick<JobsDeps, 'audit' | 'queue' | 'backlogLimit'>,
): void {
  results.set(SUMMARY_RESULT_TYPE, summaryResultHandler(deps))
  results.set(CHECK_RESULT_TYPE, checkResultHandler(deps))
}
