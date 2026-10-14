export interface ModelRequest {
  model: string
  system?: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  maxTokens: number
  effort?: 'low' | 'medium' | 'high'
}
export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}
export interface ModelReply {
  text: string
  messageId: string
  requestId: string | null
  usage: ModelUsage
}
export interface ModelClient {
  send(request: ModelRequest): Promise<ModelReply>
}

// The provider answered with an HTTP error status. Adapters wrap what their SDK throws in this, so the
// runner can tell a request the provider refused (it did no work) from one whose fate is unknown.
export class ModelRefusedError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// A definite refusal: a 4xx answer other than 408 (request timeout). The provider did not process the
// request, so the model call can be marked failed and a retry is not a duplicate. A connection error, a
// timeout or a 5xx may have been processed and charged: those stay 'started' for reconciliation.
export function isDefiniteRefusal(error: unknown): boolean {
  return (
    error instanceof ModelRefusedError && error.status >= 400 && error.status < 500 && error.status !== 408
  )
}
