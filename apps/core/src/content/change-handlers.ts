import type { PoolClient } from '@mkt/db'
import { AppError } from '../errors.ts'
import type { Actor } from './versions.ts'

// "Ask for changes" (app flow 5.6): the approver's comment closes the version (rejected, cause changes_requested,
// approvals/service.ts askForChanges), and then the item's kind may start new work from the comment, in the same
// transaction. A kind with no handler keeps the comment only. The map, by content kind, is built at server start
// (server.ts) and passed to the approval routes in ApprovalDeps.changeHandlers.

export interface ChangeContext {
  brandId: string
  itemId: string
  // The version just closed by the request: still the item's current version.
  versionId: string
  // The approver's words, untrusted (AI-6): they reach a model only wrapped and labelled as data.
  comment: string
  actor: Actor & { userId: string }
}

// What the request started: its run; or, when it started nothing, why ('revision_limit', or the code of the refusal
// of the start, such as queue_busy or agent_unavailable). null: the kind starts nothing from a comment.
export type ChangeOutcome = { runId: string } | { notStarted: string }

export type ChangeHandler = (client: PoolClient, ctx: ChangeContext) => Promise<ChangeOutcome | null>

export type ChangeHandlers = Map<string, ChangeHandler>

// Runs `work` in a savepoint of the caller's transaction. A refusal (an AppError) rolls back only what `work` wrote and
// is returned, so the caller's own writes still commit; any other error is thrown as it is and fails the whole.
export async function refusalInSavepoint<T>(
  client: PoolClient,
  work: () => Promise<T>,
): Promise<{ done: T } | { refused: AppError }> {
  await client.query('savepoint change_handler')
  let done: T
  try {
    done = await work()
  } catch (error) {
    if (!(error instanceof AppError)) throw error
    await client.query('rollback to savepoint change_handler')
    await client.query('release savepoint change_handler')
    return { refused: error }
  }
  await client.query('release savepoint change_handler')
  return { done }
}
