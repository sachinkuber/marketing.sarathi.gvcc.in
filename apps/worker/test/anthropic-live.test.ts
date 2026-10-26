import { describe, expect, it } from 'vitest'
import { summaryResultSchema, wrapBrief } from '@mkt/shared'
import { anthropicModel } from '../src/anthropic.ts'
import { SUMMARY_AGENT, providerSchema } from '../src/agents/summary.ts'

// One real request, run only when a key is in the environment. It spends a few cents.
describe('the summary request against the real provider', () => {
  it.skipIf(!process.env.ANTHROPIC_API_KEY)(
    'returns a result the core would accept',
    async () => {
      const reply = await anthropicModel(process.env.ANTHROPIC_API_KEY!).send({
        model: SUMMARY_AGENT.model,
        system: SUMMARY_AGENT.system,
        maxTokens: SUMMARY_AGENT.maxTokens,
        effort: SUMMARY_AGENT.effort,
        outputSchema: providerSchema(SUMMARY_AGENT.outputSchema),
        messages: [
          {
            role: 'user',
            content: wrapBrief('Launch a spring range of cotton kurtas for young professionals.'),
          },
        ],
      })
      expect(reply.stopReason).toBe('end_turn')
      expect(summaryResultSchema.safeParse(JSON.parse(reply.text)).success).toBe(true)
    },
    120_000,
  )
})
