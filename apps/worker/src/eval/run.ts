import { z, type ZodType } from 'zod'
import {
  briefSchema,
  RESEARCH_SOURCE_KINDS,
  researchGroupInputSchema,
  researchMergeInputSchema,
  type LoadedAgent,
} from '@mkt/shared'
import { buildResearchGroupRequest, buildResearchMergeRequest } from '../agents/research.ts'
import { buildSummaryRequest } from '../agents/summary.ts'
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
      return graded(await model.send(request))
    },
  },
  research_merge: {
    inputSchema: researchMergeInputSchema,
    run: async (model, def, input) =>
      graded(await model.send(buildResearchMergeRequest(def, researchMergeInputSchema.parse(input)))),
  },
}
