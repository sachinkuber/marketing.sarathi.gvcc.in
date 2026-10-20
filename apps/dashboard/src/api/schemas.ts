import { z } from 'zod'

// The shapes of the core's read replies, one schema per route, named after the reply. The core's contract
// test (apps/core/test/dashboard-contract.test.ts) parses its real replies with these, so a change on either
// side that breaks the other fails there. Objects are strict: a field the screen does not know is an error.
//
// Money is a string of millionths (bigint-safe); it is never a number.

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
const micros = z.string().regex(/^\d+$/)

export const money = z.strictObject({ usdMicros: micros, inrMicros: micros })

// --- status ---------------------------------------------------------------------------------------------

export const statusReply = z.strictObject({
  killSwitch: z.strictObject({
    active: z.boolean(),
    scopes: z.array(
      z.strictObject({ scope: z.enum(['brand', 'channel', 'agent']), target: z.string().nullable() }),
    ),
  }),
  shadowMode: z.boolean(),
  canApprove: z.boolean(),
  canStop: z.boolean(),
})

// --- runs -----------------------------------------------------------------------------------------------

export const runState = z.enum([
  'created',
  'running',
  'succeeded',
  'failed',
  'needs_manual',
  'cancelled',
  'held',
])

export const runSummary = z.strictObject({
  id: z.uuid(),
  agent: z.string(),
  state: runState,
  startedByKind: z.enum(['user', 'agent', 'system', 'n8n']),
  startedAt: iso,
  finishedAt: iso.nullable(),
  cost: money,
})

// --- home -----------------------------------------------------------------------------------------------

export const homeReply = z.strictObject({
  results: z
    .strictObject({
      runsThisMonth: z.number().int().nonnegative(),
      costThisMonth: money,
      lastRuns: z.array(runSummary),
    })
    .nullable(),
  progress: z
    .strictObject({
      jobs: z.strictObject({
        waiting: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
        held: z.number().int().nonnegative(),
        dead: z.number().int().nonnegative(),
        finished: z.number().int().nonnegative(),
      }),
    })
    .nullable(),
  waiting: z
    .strictObject({
      awaitingApproval: z.number().int().nonnegative(),
      oldestWaitingSince: iso.nullable(),
    })
    .nullable(),
  problems: z.strictObject({
    deadJobs: z.number().int().nonnegative(),
    openAlerts: z.number().int().nonnegative(),
    reviewCalls: z.number().int().nonnegative(),
  }),
})

// --- agents ---------------------------------------------------------------------------------------------

export const agentsReply = z.strictObject({
  items: z.array(
    z.strictObject({
      agent: z.string(),
      version: z.number().int().positive(),
      model: z.string(),
      effort: z.string(),
      state: z.enum(['running', 'blocked', 'idle']),
      costThisMonth: money,
    }),
  ),
})

// --- runs list and detail -------------------------------------------------------------------------------

export const runsReply = z.strictObject({
  items: z.array(runSummary),
  nextCursor: z.string().nullable(),
})

export const modelCall = z.strictObject({
  id: z.uuid(),
  runId: z.uuid(),
  jobId: z.uuid(),
  step: z.string(),
  model: z.string(),
  status: z.enum(['started', 'succeeded', 'failed', 'unknown']),
  possibleDuplicate: z.boolean(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  cacheReadTokens: z.number().int().nullable(),
  cacheWriteTokens: z.number().int().nullable(),
  cost: money.nullable(),
  startedAt: iso,
  finishedAt: iso.nullable(),
})

export const auditEntry = z.strictObject({
  seq: z.number().int().positive(),
  at: iso,
  actorKind: z.enum(['user', 'agent', 'system', 'n8n']),
  actorId: z.uuid().nullable(),
  action: z.string(),
  outcome: z.enum(['success', 'failure']),
  subject: z.string().nullable(),
  detail: z.unknown(),
  hash: z.string(),
})

export const runDetailReply = z.strictObject({
  run: runSummary,
  jobs: z.array(
    z.strictObject({
      id: z.uuid(),
      jobClass: z.enum(['interactive', 'publishing', 'production', 'bulk']),
      state: z.enum(['waiting', 'running', 'held', 'dead', 'finished']),
      expectedResultType: z.string(),
      resultType: z.string().nullable(),
      createdAt: iso,
      finishedAt: iso.nullable(),
      attempts: z.array(
        z.strictObject({
          number: z.number().int().positive(),
          workerId: z.string(),
          state: z.enum(['active', 'succeeded', 'failed', 'superseded']),
          startedAt: iso,
          endedAt: iso.nullable(),
        }),
      ),
    }),
  ),
  modelCalls: z.array(modelCall),
  cost: money,
  audit: z.array(auditEntry),
})

// --- model-call review ----------------------------------------------------------------------------------

export const modelCallReviewReply = z.strictObject({
  items: z.array(
    modelCall.extend({
      reason: z.enum(['unknown', 'possible_duplicate', 'no_cost']),
    }),
  ),
})

// --- audit ----------------------------------------------------------------------------------------------

export const auditReply = z.strictObject({
  items: z.array(auditEntry),
  nextBefore: z.number().int().positive().nullable(),
})

export const auditVerifyReply = z.strictObject({
  ok: z.boolean(),
  checkedAt: iso,
  findings: z.array(
    z.strictObject({
      kind: z.enum(['broken_chain', 'export_mismatch', 'log_shorter_than_export', 'chain_missing']),
      seq: z.number().int().positive().nullable(),
    }),
  ),
  lastExport: z.strictObject({ throughSeq: z.number().int().positive(), exportedAt: iso }).nullable(),
})
