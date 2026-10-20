import { withBrand, type Pool } from '@mkt/db'
import { briefSchema } from '@mkt/shared'
import { z } from 'zod'
import { startSummaryRun } from '../agents/start.ts'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { principalOf } from '../auth/session.ts'
import { cursorIsReal, listAgents, listRuns, reviewCalls, runDetail } from '../agents/reads.ts'
import { entriesAbout } from '../audit/reads.ts'
import type { AuditSink } from '../ports.ts'
import { recordRead, type OwnerView } from './audit.ts'
import type { JobsDeps } from '../jobs/service.ts'
import { inputOf, validate } from '../validate.ts'

const brandParams = z.strictObject({ brandId: z.uuid() })

// Starting an agent spends money, so it is the platform owner's for now (plan decision 5): the permission is
// see_other_brands, which only the platform owner holds.
export function registerAgentRoutes(table: RouteTable, deps: JobsDeps): void {
  table.add({
    method: 'post',
    path: '/brands/:brandId/agents/summary/runs',
    access: { kind: 'permission', permission: 'see_other_brands' },
    summary: 'Start the summary agent on a brief',
    handlers: [
      validate({ params: brandParams, body: briefSchema }),
      async (_req, res) => {
        const { body } = inputOf<{ body: z.infer<typeof briefSchema> }>(res)
        const started = await startSummaryRun(deps.pool, deps, {
          brandId: brandContextOf(res).brandId,
          brief: body.brief,
          actor: { userId: principalOf(res).userId },
        })
        res.status(201).json(started)
      },
    ],
  })
}

const runParams = z.strictObject({ brandId: z.uuid(), runId: z.uuid() })
const runsQuery = z.strictObject({
  agent: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
    .optional(),
  cursor: z.string().refine(cursorIsReal, 'not a cursor this service gave').optional(),
})

export interface AgentReadDeps {
  pool: Pool
  now: () => Date
  // The run detail reads the run's audit entries through the owner-view pool; without one that route is not
  // declared.
  audit?: { ownerView: OwnerView; sink: AuditSink }
}

// What the screens read about agents and their runs. Agents, runs, the model-call review and the audit are
// the owner's and the brand admin's (edit_profile, plan decision 5).
export function registerAgentReadRoutes(table: RouteTable, deps: AgentReadDeps): void {
  table.add({
    method: 'get',
    path: '/brands/:brandId/agents',
    access: { kind: 'permission', permission: 'edit_profile' },
    summary: 'The live agent definitions with their state and this month’s cost',
    handlers: [
      validate({ params: brandParams }),
      async (_req, res) => {
        const brandId = brandContextOf(res).brandId
        const items = await withBrand(deps.pool, brandId, (client) => listAgents(client, brandId, deps.now()))
        res.json({ items })
      },
    ],
  })

  table.add({
    method: 'get',
    path: '/brands/:brandId/runs',
    access: { kind: 'permission', permission: 'edit_profile' },
    summary: 'The brand’s runs, newest first, 50 to a page',
    handlers: [
      validate({ params: brandParams, query: runsQuery }),
      async (_req, res) => {
        const { query } = inputOf<{ query: z.infer<typeof runsQuery> }>(res)
        const brandId = brandContextOf(res).brandId
        res.json(await withBrand(deps.pool, brandId, (client) => listRuns(client, brandId, query)))
      },
    ],
  })

  table.add({
    method: 'get',
    path: '/brands/:brandId/model-calls/review',
    access: { kind: 'permission', permission: 'edit_profile' },
    summary: 'Model calls to look at: outcome unknown, possible duplicate, or succeeded with no cost row',
    handlers: [
      validate({ params: brandParams }),
      async (_req, res) => {
        const brandId = brandContextOf(res).brandId
        res.json(await withBrand(deps.pool, brandId, (client) => reviewCalls(client, brandId)))
      },
    ],
  })

  const audit = deps.audit
  if (!audit) return
  table.add({
    method: 'get',
    path: '/brands/:brandId/runs/:runId',
    access: { kind: 'permission', permission: 'edit_profile' },
    summary: 'One run: its jobs and attempts, model calls, cost and audit entries; the audit read is audited',
    handlers: [
      validate({ params: runParams }),
      async (_req, res) => {
        const { params } = inputOf<{ params: z.infer<typeof runParams> }>(res)
        const brandId = brandContextOf(res).brandId
        const detail = await withBrand(deps.pool, brandId, (client) =>
          runDetail(client, brandId, params.runId),
        )
        // audit.search has no subject filter: the core reads the brand chain newest first and keeps the
        // entries about this run.
        const about = await entriesAbout(
          audit.ownerView.pool,
          brandId,
          params.runId,
          new Date(detail.run.startedAt),
        )
        await recordRead(audit.sink, {
          actor: principalOf(res).userId,
          brandId,
          detail: { runId: params.runId },
        })
        res.json({ ...detail, audit: about.entries, auditTruncated: about.truncated })
      },
    ],
  })
}
