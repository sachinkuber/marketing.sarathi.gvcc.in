import { fileURLToPath } from 'node:url'
import { briefSchema, loadAgentDefinition, summaryResultSchema, wrapBrief } from '@mkt/shared'
import { ModelStopped, type ModelRequest } from '../model.ts'
import type { JobHandler } from '../runner.ts'

// The agent's files are read when this module loads (the worker starting), not written into the code, so
// the prompt, the model and the schema are the ones in agents/summary/.
export const SUMMARY_DIR = fileURLToPath(new URL('../../../../agents/summary/', import.meta.url))
const loaded = loadAgentDefinition(SUMMARY_DIR)

// The provider's structured output does not take length, count or range limits. The stored schema keeps them
// (and the core re-validates every result with summaryResultSchema); what is sent drops them. Names of
// properties are never touched, even when they read like a keyword.
const UNSUPPORTED = new Set([
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'pattern',
  '$schema',
])
export function providerSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const reduce = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reduce)
    if (value === null || typeof value !== 'object') return value
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      if (UNSUPPORTED.has(key)) continue
      if (key === 'properties' && inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
        out[key] = Object.fromEntries(Object.entries(inner).map(([name, sub]) => [name, reduce(sub)]))
      } else {
        out[key] = reduce(inner)
      }
    }
    return out
  }
  return reduce(schema) as Record<string, unknown>
}

export const SUMMARY_AGENT = {
  model: loaded.definition.model,
  effort: loaded.definition.effort,
  maxTokens: loaded.definition.maxTokens,
  system: loaded.system,
  outputSchema: loaded.outputSchema as Record<string, unknown>,
}

// The one place the summary request is built: the job handler sends it, and the evaluation harness sends the
// same one, so a change to the prompt, the model or the schema here is the thing that gets evaluated.
export function buildSummaryRequest(
  agent: Pick<typeof SUMMARY_AGENT, 'model' | 'effort' | 'maxTokens' | 'system' | 'outputSchema'>,
  brief: string,
): ModelRequest {
  return {
    model: agent.model,
    system: agent.system,
    maxTokens: agent.maxTokens,
    effort: agent.effort,
    outputSchema: providerSchema(agent.outputSchema),
    messages: [{ role: 'user', content: wrapBrief(brief) }],
  }
}

// The reply is not quoted anywhere: it is model output over a brief.
export class SummaryReplyInvalid extends Error {
  constructor() {
    super('The summary reply was not a valid result.')
    this.name = 'SummaryReplyInvalid'
  }
}

export const summaryHandler: JobHandler = async (ctx) => {
  const { brief } = briefSchema.parse(ctx.input)
  const step = await ctx.modelStep('summarise', buildSummaryRequest(SUMMARY_AGENT, brief))
  // A saved step from before the stop reason was kept has none; a present one must be a finished turn.
  if (step.stopReason !== undefined && step.stopReason !== 'end_turn') throw new ModelStopped(step.stopReason)
  let parsed: unknown
  try {
    parsed = JSON.parse(step.text)
  } catch {
    throw new SummaryReplyInvalid()
  }
  const result = summaryResultSchema.safeParse(parsed)
  if (!result.success) throw new SummaryReplyInvalid()
  return { type: 'summary.v1', result: result.data }
}
