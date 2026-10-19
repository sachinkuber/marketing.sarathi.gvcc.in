import { readFileSync } from 'node:fs'
import { briefSchema, summaryResultSchema, wrapBrief } from '@mkt/shared'
import { ModelStopped } from '../model.ts'
import type { JobHandler } from '../runner.ts'

// The agent's files are read when this module loads (the worker starting), not written into the code, so
// the prompt, the model and the schema are the ones in agents/summary/.
const dir = new URL('../../../../agents/summary/', import.meta.url)
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8')

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

const definition = JSON.parse(read('definition.json')) as {
  model: string
  effort: 'low' | 'medium' | 'high'
  maxTokens: number
}
export const SUMMARY_AGENT = {
  model: definition.model,
  effort: definition.effort,
  maxTokens: definition.maxTokens,
  system: read('system.md'),
  outputSchema: JSON.parse(read('output.schema.json')) as Record<string, unknown>,
}
const SENT_SCHEMA = providerSchema(SUMMARY_AGENT.outputSchema)

// The reply is not quoted anywhere: it is model output over a brief.
export class SummaryReplyInvalid extends Error {
  constructor() {
    super('The summary reply was not a valid result.')
    this.name = 'SummaryReplyInvalid'
  }
}

export const summaryHandler: JobHandler = async (ctx) => {
  const { brief } = briefSchema.parse(ctx.input)
  const step = await ctx.modelStep('summarise', {
    model: SUMMARY_AGENT.model,
    system: SUMMARY_AGENT.system,
    maxTokens: SUMMARY_AGENT.maxTokens,
    effort: SUMMARY_AGENT.effort,
    outputSchema: SENT_SCHEMA,
    messages: [{ role: 'user', content: wrapBrief(brief) }],
  })
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
