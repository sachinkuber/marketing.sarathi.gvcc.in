import { z, type ZodType } from 'zod'
import {
  briefSchema,
  factsRulesInputSchema,
  questionnaireInputSchema,
  RESEARCH_SOURCE_KINDS,
  researchGroupInputSchema,
  researchGroupResultSchema,
  researchMergeInputSchema,
  type LoadedAgent,
} from '@mkt/shared'
import { buildFactsRulesRequest } from '../agents/facts-rules.ts'
import { buildQuestionnaireRequest, withoutLoneOptions } from '../agents/questionnaire.ts'
import { buildResearchGroupRequest, buildResearchMergeRequest } from '../agents/research.ts'
import { buildSummaryRequest } from '../agents/summary.ts'
import { extractJsonObject } from '../json-reply.ts'
import type { ModelClient, ModelReply, ModelUsage } from '../model.ts'

export type EvalRunner = (
  model: ModelClient,
  def: LoadedAgent,
  input: unknown,
) => Promise<{ output: unknown; usage: ModelUsage }>

// The reply as the checks grade it: parsed JSON, or the text itself when it does not parse or the reply
// stopped early (a reply that stopped early is not a finished result, however much of it parses).
function graded(reply: ModelReply): { output: unknown; usage: ModelUsage } {
  let output: unknown = reply.text
  try {
    output = JSON.parse(reply.text)
  } catch {
    // Kept as text: the checks grade it (and schema_valid fails it).
  }
  if (reply.stopReason !== null && reply.stopReason !== 'end_turn') output = reply.text
  return { output, usage: reply.usage }
}

// A research group reply has no structured output (R24): its JSON object is read out of the text, as the job
// handler reads it, and checked with the strict schema. A valid result is graded as the schema returns it; an
// object the schema refuses is graded as it is (schema_valid fails it); text with no object stays text.
function gradedGroup(reply: ModelReply): { output: unknown; usage: ModelUsage } {
  if (reply.stopReason !== null && reply.stopReason !== 'end_turn')
    return { output: reply.text, usage: reply.usage }
  let found: Record<string, unknown>
  try {
    found = extractJsonObject(reply.text)
  } catch {
    return { output: reply.text, usage: reply.usage }
  }
  const checked = researchGroupResultSchema.safeParse(found)
  return { output: checked.success ? checked.data : found, usage: reply.usage }
}

// Evaluation never reads the live web ("recorded inputs"): a research case carries the pages and documents the
// agent would have read, and they reach the model as wrapped data in the same request the job builds.
const researchCaseSchema = z.strictObject({
  ...researchGroupInputSchema.shape,
  pages: z
    .array(
      z.strictObject({
        address: z.url({ protocol: /^https?$/ }).max(2000),
        kind: z.enum(RESEARCH_SOURCE_KINDS),
        text: z.string().min(1).max(50_000),
      }),
    )
    .max(30)
    .optional(),
  documents: z
    .array(
      z.strictObject({
        documentId: z.uuid(),
        mediaType: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']),
        base64: z.base64().min(1),
        firstPage: z.number().int().min(1).optional(),
        lastPage: z.number().int().min(1).optional(),
      }),
    )
    .max(20)
    .optional(),
})

// A questionnaire or facts and rules case may carry the owner's answers to questions the agent asked on an
// earlier attempt, as the job's attempt does (JobContext.answers), so a case can check what the agent does once
// it has been answered. Each carries the owner statement that records it (ruling R11).
const earlierAnswers = z
  .array(
    z.strictObject({
      question: z.string().min(1).max(500),
      why: z.string().min(1).max(300),
      options: z.array(z.string().min(1).max(200)).max(5),
      answer: z.string().min(1).max(2000),
      sourceId: z.uuid(),
    }),
  )
  .max(10)
const questionnaireCaseSchema = z.strictObject({
  ...questionnaireInputSchema.shape,
  answers: earlierAnswers.optional(),
})
// The facts and rules input has its own `answers` (the questionnaire's), so the earlier ones are `agentAnswers`.
// The rest is the job input, checked whole, its refinement included.
const factsRulesCaseSchema = z
  .strictObject({ ...factsRulesInputSchema.shape, agentAnswers: earlierAnswers.optional() })
  .transform(({ agentAnswers, ...input }) => ({ agentAnswers: agentAnswers ?? [], input }))
  .pipe(z.strictObject({ agentAnswers: earlierAnswers, input: factsRulesInputSchema }))

// Each runner builds the request its agent's job handler builds (through the same exported function) and
// sends it straight to the model: no core, no queue, no attempt token. M10 and M11 add their agents here.
// inputSchema is the agent's real input shape: every case's input is checked against it before a model call.
export const EVAL_RUNNERS: Record<string, { inputSchema: ZodType; run: EvalRunner }> = {
  summary: {
    inputSchema: briefSchema,
    run: async (model, def, input) => {
      const { brief } = briefSchema.parse(input)
      const reply = await model.send(
        buildSummaryRequest(
          {
            model: def.definition.model,
            effort: def.definition.effort,
            maxTokens: def.definition.maxTokens,
            system: def.system,
            outputSchema: def.outputSchema as Record<string, unknown>,
          },
          brief,
        ),
      )
      return graded(reply)
    },
  },
  research: {
    inputSchema: researchCaseSchema,
    run: async (model, def, input) => {
      const { pages, documents, ...groupInput } = researchCaseSchema.parse(input)
      const request = buildResearchGroupRequest(def, groupInput, { pages, documents })
      // The web tools are removed: the case's pages and documents are all the agent may read.
      delete request.tools
      return gradedGroup(await model.send(request))
    },
  },
  research_merge: {
    inputSchema: researchMergeInputSchema,
    run: async (model, def, input) =>
      graded(await model.send(buildResearchMergeRequest(def, researchMergeInputSchema.parse(input)))),
  },
  questionnaire: {
    inputSchema: questionnaireCaseSchema,
    run: async (model, def, input) => {
      const { answers, ...questionnaireInput } = questionnaireCaseSchema.parse(input)
      const reply = graded(
        await model.send(buildQuestionnaireRequest(def, questionnaireInput, answers ?? [])),
      )
      // Graded as the job handler would store it: a lone option becomes the suggestion first.
      return { ...reply, output: withoutLoneOptions(reply.output) }
    },
  },
  facts_rules: {
    inputSchema: factsRulesCaseSchema,
    run: async (model, def, input) => {
      const { agentAnswers, input: factsRulesInput } = factsRulesCaseSchema.parse(input)
      return graded(await model.send(buildFactsRulesRequest(def, factsRulesInput, agentAnswers)))
    },
  },
}
