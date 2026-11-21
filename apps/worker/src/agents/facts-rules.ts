import { fileURLToPath } from 'node:url'
import { wrapData, type FactsRulesInput, type LoadedAgent } from '@mkt/shared'
import type { ModelRequest } from '../model.ts'
import type { JobContext } from '../runner.ts'
import { ownerAnswersSection, section } from './request-parts.ts'
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
