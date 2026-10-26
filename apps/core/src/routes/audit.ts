import type { Pool } from '@mkt/db'
import type { Response } from 'express'
import type { Logger } from 'pino'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import { searchAudit, verifyChain, VerifyTimeout, type AuditFilters } from '../audit/reads.ts'
import type { ExportStore } from '../audit/store.ts'
import { AttemptLimiter } from '../auth/limiter.ts'
import { principalOf } from '../auth/session.ts'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'
import { inputOf, validate } from '../validate.ts'

// What reading the audit log takes: the owner-view pool (the only role that may call audit.search and the
// verify functions) and, when one exists, the write-once store of export marks.
export interface OwnerView {
  pool: Pool
  store: ExportStore | null
  // How long one verify may run in the database; default 30 s.
  verifyTimeoutMs?: number
}

export interface AuditRouteDeps {
  ownerView: OwnerView
  // The application's audit writer: every read through the owner-view pool is itself written to the log.
  audit: AuditSink
  now: () => Date
  logger?: Logger
}

const brandParams = z.strictObject({ brandId: z.uuid() })
const noParams = z.strictObject({})
const noQuery = z.strictObject({})

// A verify recomputes a whole chain, so each chain may be verified once a minute.
const VERIFY_GAP_MS = 60_000
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
  const gap = new AttemptLimiter({
    maxFailures: 1,
    windowMs: VERIFY_GAP_MS,
    lockMs: VERIFY_GAP_MS,
    now: () => deps.now().getTime(),
  })

  const search = async (res: Response, brandId: string | null, f: AuditFilters) => {
    const chain = brandId ?? 'platform'
    const page = await searchAudit(ownerView.pool, chain, f)
    await recordRead(audit, { actor: principalOf(res).userId, brandId, detail: given(f) })
    return page
  }

  const verify = async (res: Response, brandId: string | null) => {
    const key = brandId ?? 'platform'
    const wait = gap.check(key)
    if (wait > 0) {
      res.set('Retry-After', String(Math.ceil(wait / 1000)))
      throw new AppError(429, 'verify_rate_limited', 'This was checked a moment ago. Try again shortly.')
    }
    gap.fail(key)
    let result
    try {
      result = await verifyChain(
        { reader: ownerView.pool, store: ownerView.store, timeoutMs: ownerView.verifyTimeoutMs },
        key,
      )
    } catch (error) {
      if (error instanceof VerifyTimeout) {
        // The name only: the chain and the brand stay out of the log.
        deps.logger?.warn({ err: error.name }, 'audit verify timed out')
        throw new AppError(503, 'verify_timeout', 'The check took too long. Try again later.')
      }
      throw error
    }
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
      validate({ params: brandParams, query: noQuery }),
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
      validate({ params: noParams, query: noQuery }),
      async (_req, res) => {
        res.json(await verify(res, null))
      },
    ],
  })
}
