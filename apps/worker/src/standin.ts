import { appendFile } from 'node:fs/promises'
import type { ModelClient } from './model.ts'

// Test only (the entry point refuses it outside NODE_ENV=test). Answers deterministically, logs each request
// it is sent, and can kill its own process at a chosen step to imitate a crash.
export interface StandInOptions {
  logFile: string
  crashBeforeReplyOn?: string
  crashAfterReplyOn?: string
  // How long to wait before answering. The worker process takes it from STANDIN_DELAY_MS (the load test,
  // spec 17 test 41: a fixed 2 s answer), which its configuration reads only when MODEL_BACKEND=standin.
  delayMs?: number
  // What the model answers for a request, given the content of its last message (default `reply:<content>`).
  replyFor?: (step: string) => string
}

// A stable string for a message: block arrays become the text of their text blocks, with markers for
// documents and images, so logs and replies are the same for the same request.
export function contentText(content: string | unknown[]): string {
  if (typeof content === 'string') return content
  return content
    .map((b) => {
      const block = b as { type?: string; text?: unknown }
      if (block?.type === 'text' && typeof block.text === 'string') return block.text
      if (block?.type === 'document') return '[document]'
      if (block?.type === 'image') return '[image]'
      return ''
    })
    .join('')
}

export function standInModel(options: StandInOptions): ModelClient {
  return {
    async send(request) {
      const step = contentText(request.messages[request.messages.length - 1]!.content)
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
