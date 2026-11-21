import { fileURLToPath } from 'node:url'
import {
  briefChoicesInputSchema,
  briefChoicesResultSchema,
  loadAgentDefinition,
  wrapData,
  type BriefChoicesInput,
  type LoadedAgent,
} from '@mkt/shared'
import { attemptTimeoutMs } from '../model-turns.ts'
import { ModelStopped, type ModelRequest } from '../model.ts'
import type { JobContext, JobHandler } from '../runner.ts'
import { DecisionReplyInvalid, ownerAnswersSection, section } from './request-parts.ts'
import { providerSchema } from './summary.ts'

export const BRIEF_CHOICES_DIR = fileURLToPath(new URL('../../../../agents/brief_choices/', import.meta.url))
// The data parts of a brief request, shared by brief_choices and strategist so the brand's profile, facts,
// rules and answers reach both the same way: every one is wrapped as data (AI-6).
export function briefDataParts(input: BriefChoicesInput): string[] {
  return [
    wrapData('brand_name', input.brandName),
    section(
      'The brand profile:',
      input.profile.map((item) =>
        wrapData('profile_item', item.value, { key: item.key, status: item.status }),
      ),
    ),
    section(
      'Verified facts:',
      input.facts.map((fact) => wrapData('fact', fact.statement, { id: fact.id })),
    ),
    section(
      'Safety rules:',
      input.rules.map((rule) => wrapData('rule', rule.text, { kind: rule.kind })),
    ),
    section(
      "The owner's questionnaire answers:",
      input.answers.map((answer) =>
        wrapData('answer', answer.answer, { key: answer.key, question: answer.question }),
      ),
    ),
  ]
}

// The one place the brief_choices request is built: the job handler sends it, and the evaluation sends the same
// one. The first line is fixed: the e2e stand-in model recognises the agent by it. No tools, so it keeps
// structured output. Every profile value, fact statement, rule text and questionnaire answer came from research,
// the web or the owner, so each is wrapped as data (AI-6). The owner's answers to the job's earlier agent
// questions follow as owner_answer data, so a resumed attempt's step is sent again (JobContext.answers).
export function buildBriefChoicesRequest(
  agent: LoadedAgent,
  input: BriefChoicesInput,
  answers: JobContext['answers'],
): ModelRequest {
  const parts = ['Find the open strategic choices.', ...briefDataParts(input)]
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

const agent = loadAgentDefinition(BRIEF_CHOICES_DIR)

// One structured model call. A reply that asks raises the question and the job waits for the answer; a set of
// choices is returned as the result.
export const briefChoicesHandler: JobHandler = async (ctx) => {
  const input = briefChoicesInputSchema.parse(ctx.input)
  const request = {
    ...buildBriefChoicesRequest(agent, input, ctx.answers),
    timeoutMs: attemptTimeoutMs(ctx),
  }
  const reply = await ctx.modelStep('brief_choices', request)
  if (reply.stopReason !== undefined && reply.stopReason !== 'end_turn')
    throw new ModelStopped(reply.stopReason)
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.text)
  } catch {
    throw new DecisionReplyInvalid('brief choices')
  }
  const result = briefChoicesResultSchema.safeParse(parsed)
  if (!result.success) throw new DecisionReplyInvalid('brief choices')
  const { ask } = result.data
  if (ask !== null)
    return ctx.ask({ question: ask.text, why: ask.why, options: ask.options, suggested: ask.suggested })
  return { type: 'brief_choices.v1', result: result.data }
}
