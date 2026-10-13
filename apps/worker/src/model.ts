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
