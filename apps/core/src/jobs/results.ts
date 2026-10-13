import type { PoolClient } from '@mkt/db'

export interface ResultContext {
  brandId: string
  jobId: string
  runId: string
  result: unknown
}
// A result type's handler writes the business effect inside the transaction the core opens, and returns
// the outcome that a repeated post will get back.
export type ResultHandler = (client: PoolClient, context: ResultContext) => Promise<unknown>
export type ResultHandlers = Map<string, ResultHandler>
