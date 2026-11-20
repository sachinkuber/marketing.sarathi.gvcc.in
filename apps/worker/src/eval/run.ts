import type { ZodType } from 'zod'
import { briefSchema, type LoadedAgent } from '@mkt/shared'
import { buildSummaryRequest } from '../agents/summary.ts'
import type { ModelClient, ModelUsage } from '../model.ts'

export type EvalRunner = (
  model: ModelClient,
  def: LoadedAgent,
  input: unknown,
) => Promise<{ output: unknown; usage: ModelUsage }>

// Each runner builds the request its agent's job handler builds (through the same exported function) and
// sends it straight to the model: no core, no queue, no attempt token. M9 to M11 add their agents here.
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
      let output: unknown = reply.text
      try {
        output = JSON.parse(reply.text)
      } catch {
        // Kept as text: the checks grade it (and schema_valid fails it).
      }
      // A reply that stopped early is not a finished result, however much of it parses.
      if (reply.stopReason !== null && reply.stopReason !== 'end_turn') output = reply.text
      return { output, usage: reply.usage }
    },
  },
}
