import Anthropic from '@anthropic-ai/sdk'
import type { ModelClient, ModelReply, ModelRequest } from './model.ts'

// The only place the provider key is used. Streaming is not needed for the step sizes in phase 1; long
// outputs (architecture 14) will switch this one call to a stream without changing the port.
export function anthropicModel(apiKey: string): ModelClient {
  const client = new Anthropic({ apiKey })
  return {
    async send(request: ModelRequest): Promise<ModelReply> {
      const response = await client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        ...(request.system ? { system: request.system } : {}),
        ...(request.effort ? { output_config: { effort: request.effort } } : {}),
        messages: request.messages,
      })
      const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
      return {
        text,
        messageId: response.id,
        requestId: (response as { _request_id?: string | null })._request_id ?? null,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
      }
    },
  }
}
