import { fileURLToPath } from 'node:url'
import { wrapData, type LoadedAgent, type QuestionnaireInput } from '@mkt/shared'
import type { ModelRequest } from '../model.ts'
import type { JobContext } from '../runner.ts'
import { providerSchema } from './summary.ts'

export const QUESTIONNAIRE_DIR = fileURLToPath(new URL('../../../../agents/questionnaire/', import.meta.url))

const section = (title: string, blocks: string[]): string =>
  `${title}\n${blocks.length === 0 ? 'None.' : blocks.join('\n')}`

// The one place the questionnaire request is built: the job handler sends it, and the evaluation sends the same
// one. No tools, so it keeps structured output. Every profile value, suggestion, gap reason, source address and
// competitor came from research, the web or the owner, so each is wrapped as data, its key and status as
// attributes; an open suggestion says whether the owner rejected it (ruling R9). The owner's answers to the job's earlier agent questions follow as owner_answer data: a resumed
// attempt's request then differs from the one that asked, so its step is sent again instead of replaying the
// checkpoint that asked (JobContext.answers).
export function buildQuestionnaireRequest(
  agent: LoadedAgent,
  input: QuestionnaireInput,
  answers: JobContext['answers'],
): ModelRequest {
  const parts = [
    wrapData('brand_name', input.brandName),
    section(
      'The profile the owner accepted:',
      input.profile.map((item) =>
        wrapData('profile_item', item.value, { key: item.key, status: item.status }),
      ),
    ),
    section(
      'Research suggestions the owner has not accepted:',
      input.open.map((open) =>
        wrapData('open_suggestion', open.proposed, {
          key: open.key,
          confidence: open.confidence,
          rejected: String(open.rejected),
        }),
      ),
    ),
    section(
      'Profile keys research could not settle:',
      input.gaps.map((gap) => wrapData('gap', gap.why, { key: gap.key })),
    ),
    section(
      'Sources research could not read:',
      input.unreadable.map((source) =>
        wrapData('unreadable_source', source.address ?? 'no address recorded', { kind: source.kind }),
      ),
    ),
    section(
      'Competitors the owner named:',
      input.competitors.map((competitor) =>
        wrapData(
          'competitor',
          competitor.name,
          competitor.website === null ? {} : { website: competitor.website },
        ),
      ),
    ),
  ]
  if (answers.length > 0)
    parts.push(
      section(
        "The owner's answers to your earlier questions, oldest first:",
        answers.map(({ question, why, options, answer }) =>
          wrapData('owner_answer', JSON.stringify({ question, why, options, answer })),
        ),
      ),
    )
  return {
    model: agent.definition.model,
    system: agent.system,
    maxTokens: agent.definition.maxTokens,
    effort: agent.definition.effort,
    outputSchema: providerSchema(agent.outputSchema as Record<string, unknown>),
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  }
}
