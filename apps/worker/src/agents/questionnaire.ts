import { fileURLToPath } from 'node:url'
import {
  loadAgentDefinition,
  questionnaireInputSchema,
  questionnaireResultSchema,
  wrapData,
  type LoadedAgent,
  type QuestionnaireInput,
} from '@mkt/shared'
import { attemptTimeoutMs } from '../model-turns.ts'
import { ModelStopped, type ModelRequest } from '../model.ts'
import type { JobContext, JobHandler } from '../runner.ts'
import { DecisionReplyInvalid, ownerAnswersSection, section } from './request-parts.ts'
import { providerSchema } from './summary.ts'

export const QUESTIONNAIRE_DIR = fileURLToPath(new URL('../../../../agents/questionnaire/', import.meta.url))

// The one place the questionnaire request is built: the job handler sends it, and the evaluation sends the
// same one. No tools, so it keeps structured output. Every profile value, suggestion, gap reason, source
// address and competitor came from research, the web or the owner, so each is wrapped as data, with its key
// and status as attributes; an open suggestion also says whether the owner rejected it (ruling R9). The
// owner's answers to the job's earlier agent questions follow as owner_answer data: a resumed attempt's
// request then differs from the one that asked, so its step is sent again instead of replaying the checkpoint
// that asked (JobContext.answers).
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

const agent = loadAgentDefinition(QUESTIONNAIRE_DIR)

// The model sometimes offers a stated value as the only option (the business name, the owner's own description),
// even when told not to: in the milestone 10 production evaluation it did so in 3 of 10 cases. A question has no
// options or two to six, so a lone option becomes the question's suggestion instead (when it has none) and the
// list is emptied. Nothing is chosen for the owner: a suggestion is shown, never pre-filled (R40). Anything that is
// not such a question is left as it is, for the result check to judge.
export function withoutLoneOptions(reply: unknown): unknown {
  if (typeof reply !== 'object' || reply === null) return reply
  const { questions } = reply as { questions?: unknown }
  if (!Array.isArray(questions)) return reply
  return {
    ...reply,
    questions: questions.map((question: unknown) => {
      if (typeof question !== 'object' || question === null) return question
      const { options, suggestedAnswer } = question as { options?: unknown; suggestedAnswer?: unknown }
      if (!Array.isArray(options) || options.length !== 1) return question
      return {
        ...question,
        options: [],
        suggestedAnswer: suggestedAnswer === null ? options[0] : suggestedAnswer,
      }
    }),
  }
}

// One structured model call. A reply that asks raises the question and the job waits for the answer; a
// questionnaire is returned as the result. The request carries the job's answers, so the resumed attempt's step
// is a new request and is not replayed.
export const questionnaireHandler: JobHandler = async (ctx) => {
  const input = questionnaireInputSchema.parse(ctx.input)
  const request = {
    ...buildQuestionnaireRequest(agent, input, ctx.answers),
    timeoutMs: attemptTimeoutMs(ctx),
  }
  const reply = await ctx.modelStep('questionnaire', request)
  if (reply.stopReason !== undefined && reply.stopReason !== 'end_turn')
    throw new ModelStopped(reply.stopReason)
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.text)
  } catch {
    throw new DecisionReplyInvalid('questionnaire')
  }
  const result = questionnaireResultSchema.safeParse(withoutLoneOptions(parsed))
  if (!result.success) throw new DecisionReplyInvalid('questionnaire')
  const { ask } = result.data
  if (ask !== null)
    return ctx.ask({ question: ask.text, why: ask.why, options: ask.options, suggested: ask.suggested })
  return { type: 'questionnaire.v1', result: result.data }
}
