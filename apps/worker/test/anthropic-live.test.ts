import { describe, expect, it } from 'vitest'
import { summaryResultSchema, wrapBrief } from '@mkt/shared'
import Anthropic from '@anthropic-ai/sdk'
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

// R13 probe: does the API accept a continuation whose history holds server-tool blocks when that tool is left
// out (a), or listed with max_uses 0 (b)? Run by hand with LIVE_ANTHROPIC=1 and a key; it spends a few cents.
// The outcome decides how modelTurns treats a spent tool budget.
// Run 2026-11-21: (b) max_uses 0 was refused; (a) could not be tested, because the probe's completed turn counts as
// a prefill. So modelTurns keeps the tool at max_uses 1 on a continuation.
describe('spent tool budget forms against the real provider', () => {
  const live = process.env.LIVE_ANTHROPIC === '1' && !!process.env.ANTHROPIC_API_KEY
  const history = async (client: Anthropic) => {
    // A real search turn to get valid server-tool blocks into a history.
    const first = await client.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 400,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 1 }],
      messages: [
        { role: 'user', content: 'Search once for the current weather in Pune, then answer in one line.' },
      ],
    })
    return first.content
  }
  const attempt = async (tools: Anthropic.ToolUnion[] | undefined) => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const blocks = await history(client)
    try {
      await client.messages.create({
        model: 'claude-sonnet-5-5',
        max_tokens: 200,
        ...(tools ? { tools } : {}),
        messages: [
          { role: 'user', content: 'Search once for the current weather in Pune, then answer in one line.' },
          { role: 'assistant', content: blocks as Anthropic.ContentBlockParam[] },
        ],
      })
      return 'accepted'
    } catch (error) {
      return `rejected: ${error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : String(error)}`
    }
  }
  it.skipIf(!live)(
    '(a) the tool left out of a request whose history has its blocks',
    async () => {
      console.log('probe (a):', await attempt(undefined))
    },
    120_000,
  )
  it.skipIf(!live)(
    '(b) the tool listed with max_uses 0',
    async () => {
      console.log(
        'probe (b):',
        await attempt([{ type: 'web_search_20260209', name: 'web_search', max_uses: 0 }]),
      )
    },
    120_000,
  )
})
