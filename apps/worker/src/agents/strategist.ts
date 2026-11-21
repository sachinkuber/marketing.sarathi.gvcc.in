import { fileURLToPath } from 'node:url'
import {
  loadAgentDefinition,
  strategistInputSchema,
  strategyBriefAgainstInput,
  strategyBriefResultSchema,
  wrapData,
  type LoadedAgent,
  type StrategistInput,
} from '@mkt/shared'
import { attemptTimeoutMs } from '../model-turns.ts'
import { ModelStopped, type ModelRequest } from '../model.ts'
import type { JobContext, JobHandler } from '../runner.ts'
import { briefDataParts } from './brief-choices.ts'
import { DecisionReplyInvalid, ownerAnswersSection, section } from './request-parts.ts'
import { providerSchema } from './summary.ts'

export const STRATEGIST_DIR = fileURLToPath(new URL('../../../../agents/strategist/', import.meta.url))

// The one place the strategist request is built: the job handler sends it, and the evaluation sends the same
// one. The first two lines are fixed (the e2e stand-in model recognises the agent by the first). No tools, so it
// keeps structured output. Everything after them is data (AI-6): the brand's profile, facts, rules and answers as
// brief_choices sends them, the owner's picks, the owner's baseline, and, when the owner asked for changes, the
// approver's comment and the brief it is about. The owner's answers to the job's earlier agent questions follow
// as owner_answer data, so a resumed attempt's step is sent again (JobContext.answers).
export function buildStrategistRequest(
  agent: LoadedAgent,
  input: StrategistInput,
  answers: JobContext['answers'],
): ModelRequest {
  const parts = [
    'Write the strategy brief.',
    `Today is ${input.today}.`,
    ...briefDataParts(input),
    section(
      "The owner's picks:",
      input.picks.map((pick) =>
        wrapData('pick', JSON.stringify({ picked: pick.picked, notTaken: pick.notTaken }), {
          key: pick.key,
          question: pick.question,
        }),
      ),
    ),
    input.baseline === null ? 'No baseline figures are given.' : wrapData('baseline', input.baseline),
  ]
  if (input.changeRequest !== null)
    parts.push(
      wrapData('change_request', input.changeRequest.comment),
      wrapData('previous_brief', input.changeRequest.previous),
    )
  const earlier = ownerAnswersSection(answers)
  if (earlier !== null) parts.push(earlier)
  return {
    model: agent.definition.model,
    system: agent.system,
    maxTokens: agent.definition.maxTokens,
    effort: agent.definition.effort,
    outputSchema: providerSchema(agent.outputSchema as Record<string, unknown>),
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  }
}

const agent = loadAgentDefinition(STRATEGIST_DIR)

// One structured model call. The reply is also checked against the input (every cited fact is in the input,
// every pick key is the owner's, every goal starts at the baseline marker while no baseline is given), so a bad
// citation fails the attempt here and not only at the core. A reply that asks raises the question and the job
// waits for the answer; a brief is returned as the result.
export const strategistHandler: JobHandler = async (ctx) => {
  const input = strategistInputSchema.parse(ctx.input)
  const request = { ...buildStrategistRequest(agent, input, ctx.answers), timeoutMs: attemptTimeoutMs(ctx) }
  const reply = await ctx.modelStep('strategist', request)
  if (reply.stopReason !== undefined && reply.stopReason !== 'end_turn')
    throw new ModelStopped(reply.stopReason)
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.text)
  } catch {
    throw new DecisionReplyInvalid('strategist')
  }
  const result = strategyBriefResultSchema.safeParse(parsed)
  if (!result.success) throw new DecisionReplyInvalid('strategist')
  if (strategyBriefAgainstInput(result.data, input).length > 0) throw new DecisionReplyInvalid('strategist')
  const { ask } = result.data
  if (ask !== null)
    return ctx.ask({ question: ask.text, why: ask.why, options: ask.options, suggested: ask.suggested })
  return { type: 'strategy_brief.v1', result: result.data }
}
