import Anthropic from '@anthropic-ai/sdk'
import { ModelRefusedError, type ModelClient, type ModelReply, type ModelRequest } from './model.ts'

// The only place the provider key is used. Streaming is not needed for the step sizes in phase 1; long
// outputs (architecture 14) will switch this one call to a stream without changing the port.
export function anthropicModel(apiKey: string): ModelClient {
  // No SDK retries: one model call row stands for one provider request, and a retry goes through the queue
  // and the ledger where it is counted (and flagged when the first request's fate is unknown).
  const client = new Anthropic({ apiKey, maxRetries: 0 })
  return {
    async send(request: ModelRequest): Promise<ModelReply> {
      let response
      try {
        response = await client.messages.create({
          model: request.model,
          max_tokens: request.maxTokens,
          ...(request.system ? { system: request.system } : {}),
          ...(request.effort ? { output_config: { effort: request.effort } } : {}),
          messages: request.messages,
        })
      } catch (error) {
        // An HTTP error status carries its code to the runner; a connection error or timeout passes as is.
        if (error instanceof Anthropic.APIError && typeof error.status === 'number') {
          throw new ModelRefusedError(error.status, error.message)
        }
        throw error
      }
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
