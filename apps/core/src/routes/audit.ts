import type { Pool } from '@mkt/db'
import type { Response } from 'express'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { searchAudit, verifyChain, type AuditFilters } from '../audit/reads.ts'
import type { ExportStore } from '../audit/store.ts'
import { principalOf } from '../auth/session.ts'
import type { AuditSink } from '../ports.ts'
import { inputOf, validate } from '../validate.ts'

// What reading the audit log takes: the owner-view pool (the only role that may call audit.search and the
// verify functions) and, when one exists, the write-once store of export marks.
export interface OwnerView {
  pool: Pool
  store: ExportStore | null
}

export interface AuditRouteDeps {
  ownerView: OwnerView
  // The application's audit writer: every read through the owner-view pool is itself written to the log.
  audit: AuditSink
  now: () => Date
}

const brandParams = z.strictObject({ brandId: z.uuid() })
const filters = z.strictObject({
  actor: z.uuid().optional(),
  action: z
    .string()
    .max(120)
    .regex(/^[a-z][a-z0-9_.]*$/)
    .optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  before: z.coerce.number().int().positive().optional(),
})

// Only the filters that were given: the entry names what was asked for, never what came back.
const given = (f: AuditFilters): Record<string, unknown> =>
  Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined))

// One `audit.read` per read of the log through the owner-view pool. It is written after the read and before
// the reply, so rows that were not audited are never returned.
export async function recordRead(
  audit: AuditSink,
  entry: { actor: string; brandId: string | null; detail: Record<string, unknown> },
): Promise<void> {
  await audit.record({
    action: 'audit.read',
    actor: entry.actor,
    subject: entry.brandId ?? 'platform',
    brandId: entry.brandId,
    outcome: 'success',
    detail: entry.detail,
  })
}

export function registerAuditRoutes(table: RouteTable, deps: AuditRouteDeps): void {
  const { ownerView, audit } = deps

  const search = async (res: Response, brandId: string | null, f: AuditFilters) => {
    const chain = brandId ?? 'platform'
    const page = await searchAudit(ownerView.pool, chain, f)
    await recordRead(audit, { actor: principalOf(res).userId, brandId, detail: given(f) })
    return page
  }

  const verify = async (res: Response, brandId: string | null) => {
    const result = await verifyChain(
      { reader: ownerView.pool, store: ownerView.store },
      brandId ?? 'platform',
    )
    await audit.record({
      action: 'audit.verified',
      actor: principalOf(res).userId,
      subject: brandId ?? 'platform',
      brandId,
      outcome: 'success',
      detail: { ok: result.ok, findings: result.findings.length },
    })
    return { ...result, checkedAt: deps.now().toISOString() }
  }

  table.add({
    method: 'get',
    path: '/brands/:brandId/audit',
    access: { kind: 'permission', permission: 'edit_profile' },
    summary: "Search the brand's audit entries, newest first; the read is itself audited",
    handlers: [
      validate({ params: brandParams, query: filters }),
      async (_req, res) => {
        const { query } = inputOf<{ query: AuditFilters }>(res)
        res.json(await search(res, brandContextOf(res).brandId, query))
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/audit/verify',
    access: { kind: 'permission', permission: 'edit_profile' },
    summary: "Check the brand's audit chain against itself and the copies outside the server; audited",
    handlers: [
      validate({ params: brandParams }),
      async (_req, res) => {
        res.json(await verify(res, brandContextOf(res).brandId))
      },
    ],
  })

  table.add({
    method: 'get',
    path: '/audit/platform',
    access: { kind: 'platform_owner' },
    summary: 'Search the platform audit entries, newest first; the read is itself audited',
    handlers: [
      validate({ query: filters }),
      async (_req, res) => {
        const { query } = inputOf<{ query: AuditFilters }>(res)
        res.json(await search(res, null, query))
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/audit/platform/verify',
    access: { kind: 'platform_owner' },
    summary: 'Check the platform audit chain against itself and the copies outside the server; audited',
    handlers: [
      async (_req, res) => {
        res.json(await verify(res, null))
      },
    ],
  })
}
