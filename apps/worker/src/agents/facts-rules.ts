import { fileURLToPath } from 'node:url'
import {
  factsRulesAgainstInput,
  factsRulesInputSchema,
  factsRulesResultSchema,
  loadAgentDefinition,
  wrapData,
  type FactsRulesInput,
  type LoadedAgent,
} from '@mkt/shared'
import { attemptTimeoutMs } from '../model-turns.ts'
import { ModelStopped, type ModelRequest } from '../model.ts'
import type { JobContext, JobHandler } from '../runner.ts'
import { DecisionReplyInvalid, ownerAnswersSection, section } from './request-parts.ts'
import { providerSchema } from './summary.ts'

export const FACTS_RULES_DIR = fileURLToPath(new URL('../../../../agents/facts_rules/', import.meta.url))

// The one place the facts and rules request is built: the job handler sends it, and the evaluation sends the
// same one. No tools, so it keeps structured output. Today's date is the core's, checked by the input schema;
// everything else came from the owner, research or the web, so each extract, document name, address, profile
// value, question and answer is wrapped as data, with the ids a fact or rule may cite as attributes. The
// owner's answers to the job's earlier agent questions follow as owner_answer data, so a resumed attempt's
// request differs from the one that asked (JobContext.answers). Each is also listed with the sources as the
// owner statement that records it (its exact answer, with the question as context), so a fact or rule it
// settles can cite it (ruling R11).
export function buildFactsRulesRequest(
  agent: LoadedAgent,
  input: FactsRulesInput,
  answers: JobContext['answers'],
): ModelRequest {
  const parts = [
    `Today is ${input.today}.`,
    wrapData('brand_name', input.brandName),
    section('Sources:', [
      ...input.sources.map((source) =>
        wrapData('source', source.extract, {
          id: source.id,
          kind: source.kind,
          ...(source.address === null ? {} : { address: source.address }),
          ...(source.documentName === null ? {} : { document: source.documentName }),
        }),
      ),
      ...answers.map((answer) =>
        wrapData('source', answer.answer, {
          id: answer.sourceId,
          kind: 'owner_statement',
          question: answer.question,
        }),
      ),
    ]),
    section(
      'The profile the owner accepted:',
      input.profile.map((item) =>
        wrapData('profile_item', item.value, {
          key: item.key,
          status: item.status,
          sources: item.sourceIds.join(' '),
        }),
      ),
    ),
    section(
      "The owner's answers to the questionnaire:",
      input.answers.map((answer) =>
        wrapData('answer', answer.answer, {
          key: answer.key,
          source: answer.sourceId,
          question: answer.question,
        }),
      ),
    ),
  ]
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

const agent = loadAgentDefinition(FACTS_RULES_DIR)

// One structured model call, as the questionnaire's. The reply is also checked against the input (every cited
// id is a listed source or an answered question's statement, every review date is after today), so a bad
// citation fails the attempt here and not only at the core.
export const factsRulesHandler: JobHandler = async (ctx) => {
  const input = factsRulesInputSchema.parse(ctx.input)
  const request = { ...buildFactsRulesRequest(agent, input, ctx.answers), timeoutMs: attemptTimeoutMs(ctx) }
  const reply = await ctx.modelStep('facts_rules', request)
  if (reply.stopReason !== undefined && reply.stopReason !== 'end_turn')
    throw new ModelStopped(reply.stopReason)
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.text)
  } catch {
    throw new DecisionReplyInvalid('facts and rules')
  }
  const result = factsRulesResultSchema.safeParse(parsed)
  if (!result.success) throw new DecisionReplyInvalid('facts and rules')
  if (factsRulesAgainstInput(result.data, input, ctx.answers).length > 0)
    throw new DecisionReplyInvalid('facts and rules')
  const { ask } = result.data
  if (ask !== null)
    return ctx.ask({ question: ask.text, why: ask.why, options: ask.options, suggested: ask.suggested })
  return { type: 'facts_rules.v1', result: result.data }
}
