import { wrapData } from '@mkt/shared'
import type { JobContext } from '../runner.ts'

// A titled list of wrapped blocks, or "None." so the agent reads an empty list as empty, not as missing.
export const section = (title: string, blocks: string[]): string =>
  `${title}\n${blocks.length === 0 ? 'None.' : blocks.join('\n')}`

// The owner's answers to the job's earlier agent questions, oldest first, as owner_answer data (null when there
// are none). A resumed attempt's request then differs from the one that asked, so its step is sent again
// instead of replaying the checkpoint that asked (JobContext.answers). Each is a fixed {question, why, options,
// answer}, so an extra field from the core never reaches the request and the order is stable.
export function ownerAnswersSection(answers: JobContext['answers']): string | null {
  if (answers.length === 0) return null
  return section(
    "The owner's answers to your earlier questions, oldest first:",
    answers.map(({ question, why, options, answer }) =>
      wrapData('owner_answer', JSON.stringify({ question, why, options, answer })),
    ),
  )
}

// A decision agent's reply that is not a valid result (not JSON, a schema or citation refusal). Not quoted: it is
// model output over untrusted text. The attempt fails and retries under the Phase 1 rules; no repair request.
export class DecisionReplyInvalid extends Error {
  constructor(agent: string) {
    super(`The ${agent} reply was not a valid result.`)
    this.name = 'DecisionReplyInvalid'
  }
}
