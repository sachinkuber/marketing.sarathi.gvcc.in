import type { ResultHandlers } from '../jobs/results.ts'
import type { JobsDeps, SettledHooks } from '../jobs/service.ts'
import { GROUP_RESULT_TYPE, MERGE_RESULT_TYPE } from '../onboarding/research.ts'
import {
  maybeStartMerge,
  researchGroupResultHandler,
  researchResultHandler,
} from '../onboarding/research-results.ts'
import { QUESTIONNAIRE_RESULT_TYPE, questionnaireResultHandler } from '../onboarding/questionnaire.ts'
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

// The result types of the research agents (spec 6, 8) and their handlers. A research group also settles its run
// itself: when the last group finishes or dies, the merge starts (a dead group does not fail the run).
export function registerResearchHandlers(
  results: ResultHandlers,
  settled: SettledHooks,
  deps: Pick<JobsDeps, 'audit' | 'queue' | 'backlogLimit'>,
): void {
  results.set(GROUP_RESULT_TYPE, researchGroupResultHandler())
  results.set(MERGE_RESULT_TYPE, researchResultHandler(deps))
  settled.set(GROUP_RESULT_TYPE, async (client, context) => {
    await maybeStartMerge(client, deps, context)
  })
}

// The questionnaire agent's result type (spec 4, 12): the questions are stored in order for the owner to answer.
export function registerQuestionnaireHandlers(results: ResultHandlers): void {
  results.set(QUESTIONNAIRE_RESULT_TYPE, questionnaireResultHandler())
}
