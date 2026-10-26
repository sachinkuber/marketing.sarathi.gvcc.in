import { appendFile } from 'node:fs/promises'
import type { ModelClient } from './model.ts'

// Test only (the entry point refuses it outside NODE_ENV=test). Answers deterministically, logs each request
// it is sent, and can kill its own process at a chosen step to imitate a crash.
export interface StandInOptions {
  logFile: string
  crashBeforeReplyOn?: string
  crashAfterReplyOn?: string
  delayMs?: number
  // What the model answers for a request, given the content of its last message (default `reply:<content>`).
  replyFor?: (step: string) => string
}

export function standInModel(options: StandInOptions): ModelClient {
  return {
    async send(request) {
      const step = request.messages[request.messages.length - 1]!.content
      await appendFile(options.logFile, `sent ${step}\n`)
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      if (options.crashBeforeReplyOn === step) process.kill(process.pid, 'SIGKILL')
      const reply = {
        text: options.replyFor ? options.replyFor(step) : `reply:${step}`,
        messageId: `msg_${step}_${Math.random().toString(36).slice(2, 10)}`,
        requestId: null,
        stopReason: 'end_turn',
        usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      // The provider has answered and been charged; the process dies before it can say so.
      if (options.crashAfterReplyOn === step) process.kill(process.pid, 'SIGKILL')
      return reply
    },
  }
}
