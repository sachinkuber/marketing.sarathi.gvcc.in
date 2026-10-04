import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY)

describe.skipIf(!hasKey)('the pinned SDK works with claude-opus-5-5', () => {
  it('returns text, a message ID and token usage', async () => {
    const client = new Anthropic()
    const response = await client.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 2048,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    })

    expect(response.stop_reason).toBe('end_turn')
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    expect(text.toLowerCase()).toContain('ready')
    expect(response.id).toMatch(/^msg_/)
    expect(response.usage.input_tokens).toBeGreaterThan(0)
    expect(response.usage.output_tokens).toBeGreaterThan(0)
  }, 120_000)
})
