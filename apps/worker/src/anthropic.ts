import Anthropic from '@anthropic-ai/sdk'
import { ModelRefusedError, type ModelClient, type ModelReply, type ModelRequest } from './model.ts'

// A request must end before the queue expires the job (the shortest class expiry is interactive, 300 s):
// a request that outlives it holds a slot until the job is taken away and its late checkpoint is refused.
// The SDK's own default is ten minutes. 240 s leaves the job room to checkpoint.
export const DEFAULT_MODEL_TIMEOUT_MS = 240_000

// The only place the provider key is used. Streaming is not needed for the step sizes in phase 1; long
// outputs (architecture 14) will switch this one call to a stream without changing the port.
export interface AnthropicOptions {
  timeoutMs?: number
  // Tests inject a fake client factory.
  makeClient?: (options: { apiKey: string; maxRetries: number; timeout: number }) => Anthropic
}

export function anthropicModel(apiKey: string, options: AnthropicOptions = {}): ModelClient {
  // No SDK retries: one model call row stands for one provider request, and a retry goes through the queue
  // and the ledger where it is counted (and flagged when the first request's fate is unknown).
  const clientOptions = { apiKey, maxRetries: 0, timeout: options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS }
  const client = options.makeClient ? options.makeClient(clientOptions) : new Anthropic(clientOptions)
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
