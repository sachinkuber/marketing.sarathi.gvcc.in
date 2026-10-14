import type { PoolClient } from '@mkt/db'

export interface ResultContext {
  brandId: string
  jobId: string
  runId: string
  result: unknown
}
// A result type's handler writes the business effect inside the transaction the core opens, and returns
// the outcome that a repeated post will get back.
// Contract: the handler runs holding the job's job_input row lock and then the run row lock (in that
// order, taken by the core before the handler), inside the brand transaction. Use the
// given `client` only; do no external I/O (network, other services) and open no other pool connection.
// Throwing rolls the whole result back; an AppError keeps its status, anything else answers 500.
export type ResultHandler = (client: PoolClient, context: ResultContext) => Promise<unknown>
export type ResultHandlers = Map<string, ResultHandler>
