import type { ResultHandlers } from '../jobs/results.ts'
import type { JobsDeps, SettledHooks } from '../jobs/service.ts'
import { GROUP_RESULT_TYPE, MERGE_RESULT_TYPE } from '../onboarding/research.ts'
import {
  maybeStartMerge,
  researchGroupResultHandler,
  researchResultHandler,
} from '../onboarding/research-results.ts'
import { STRATEGY_BRIEF_RESULT_TYPE, strategyBriefResultHandler } from '../onboarding/brief.ts'
import { BRIEF_CHOICES_RESULT_TYPE, briefChoicesResultHandler } from '../onboarding/brief-choices.ts'
import { FACTS_RULES_RESULT_TYPE, factsRulesResultHandler } from '../onboarding/facts-rules.ts'
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

// The facts and rules agent's result type (spec 7, 8.2): the facts and rules become suggestions for the owner.
export function registerFactsRulesHandlers(results: ResultHandlers, deps: Pick<JobsDeps, 'audit'>): void {
  results.set(FACTS_RULES_RESULT_TYPE, factsRulesResultHandler(deps))
}

// The brief choices agent's result type (spec 4, 6): the choices become suggestions for the owner to settle.
export function registerBriefChoicesHandlers(results: ResultHandlers, deps: Pick<JobsDeps, 'audit'>): void {
  results.set(BRIEF_CHOICES_RESULT_TYPE, briefChoicesResultHandler(deps))
}

// The strategist's result type (spec 10): the brief becomes a version of the brand's strategy_brief item, waiting
// for the platform owner's approval.
export function registerStrategistHandlers(results: ResultHandlers, deps: Pick<JobsDeps, 'audit'>): void {
  results.set(STRATEGY_BRIEF_RESULT_TYPE, strategyBriefResultHandler(deps))
}
