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
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      try {
        const body = {
          model: request.model,
          max_tokens: request.maxTokens,
          ...(request.system ? { system: request.system } : {}),
          ...(request.effort || request.outputSchema
            ? {
                output_config: {
                  ...(request.effort ? { effort: request.effort } : {}),
                  ...(request.outputSchema
                    ? { format: { type: 'json_schema' as const, schema: request.outputSchema } }
                    : {}),
                },
              }
            : {}),
          ...(request.tools && request.tools.length > 0
            ? {
                tools: request.tools.map((tool) =>
                  tool.type === 'web_search_20260209'
                    ? { type: tool.type, name: 'web_search' as const, max_uses: tool.maxUses }
                    : {
                        type: tool.type,
                        name: 'web_fetch' as const,
                        max_uses: tool.maxUses,
                        ...(tool.maxContentTokens === undefined
                          ? {}
                          : { max_content_tokens: tool.maxContentTokens }),
                      },
                ),
              }
            : {}),
          messages: request.messages as Anthropic.MessageParam[],
        }
        // The SDK's timeout covers only the wait for the response headers: its timer is cleared once they
        // arrive, so a stream that then stalls would never end. The adapter bounds the whole request with its
        // own timer and abort signal, and clears the timer when the request ends.
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, request.timeoutMs ?? clientOptions.timeout)
        const requestOptions = {
          ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
          signal: controller.signal,
        }
        // A request with tools can run for many minutes: it is streamed and read as its final message, because
        // a non-streaming call that long is cut off by the HTTP client's own header timeout. A request without
        // tools (summary) is sent as before.
        response =
          request.tools && request.tools.length > 0
            ? await client.messages.stream(body, requestOptions).finalMessage()
            : await client.messages.create(body, requestOptions)
      } catch (error) {
        // Cut by the adapter's own timer: the same error as the SDK's header timeout, so the runner treats both
        // alike (not a refusal; the call stays started for reconciliation and the job retries).
        if (timedOut) throw new Anthropic.APIConnectionTimeoutError()
        // An HTTP error status carries its code to the runner; a connection error or timeout passes as is.
        if (error instanceof Anthropic.APIError && typeof error.status === 'number') {
          throw new ModelRefusedError(error.status, error.message)
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
      const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
      return {
        text,
        content: response.content as unknown[],
        messageId: response.id,
        stopReason: response.stop_reason ?? null,
        requestId: (response as { _request_id?: string | null })._request_id ?? null,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
          serverToolSearches: response.usage.server_tool_use?.web_search_requests ?? 0,
          serverToolFetches: response.usage.server_tool_use?.web_fetch_requests ?? 0,
        },
      }
    },
  }
}
