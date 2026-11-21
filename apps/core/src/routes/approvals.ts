import type { Pool } from '@mkt/db'
import { z } from 'zod'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import {
  approve,
  askForChanges,
  comment,
  COMMENT_MAX,
  reject,
  type ApprovalDeps,
} from '../approvals/service.ts'
import { principalOf } from '../auth/session.ts'
import { inputOf, validate } from '../validate.ts'

export interface ApprovalRouteDeps extends ApprovalDeps {
  pool: Pool
}

const params = z.strictObject({ brandId: z.uuid(), itemId: z.uuid(), versionId: z.uuid() })
const approveBody = z.strictObject({ hash: z.string().min(1).max(200), hash_scheme: z.literal('cv1') })
const text = z.string().trim().min(1).max(COMMENT_MAX)
const rejectBody = z.strictObject({ reason: text })
const commentBody = z.strictObject({ text })
const changesBody = z.strictObject({ comment: text })

type P = z.infer<typeof params>

export function registerApprovalRoutes(table: RouteTable, deps: ApprovalRouteDeps): void {
  // The route needs approve_content; the service also checks the item's kind against the person's role (only the
  // platform owner decides on a strategy brief).
  const target = (res: Parameters<typeof brandContextOf>[0], p: P) => ({
    brandId: brandContextOf(res).brandId,
    itemId: p.itemId,
    versionId: p.versionId,
    actor: { kind: 'user' as const, userId: principalOf(res).userId },
    role: brandContextOf(res).actor,
  })
  const base = '/brands/:brandId/content/:itemId/versions/:versionId'

  table.add({
    method: 'post',
    path: `${base}/approve`,
    access: { kind: 'permission', permission: 'approve_content' },
    summary: 'Approve a version that is awaiting approval, naming the hash that was reviewed',
    handlers: [
      validate({ params, body: approveBody }),
      async (_req, res) => {
        const { params: p, body } = inputOf<{ params: P; body: z.infer<typeof approveBody> }>(res)
        const done = await approve(deps.pool, deps, {
          ...target(res, p),
          hash: body.hash,
          scheme: body.hash_scheme,
        })
        res.status(201).json(done)
      },
    ],
  })

  table.add({
    method: 'post',
    path: `${base}/reject`,
    access: { kind: 'permission', permission: 'approve_content' },
    summary: 'Reject a version that is awaiting approval, with a reason',
    handlers: [
      validate({ params, body: rejectBody }),
      async (_req, res) => {
        const { params: p, body } = inputOf<{ params: P; body: z.infer<typeof rejectBody> }>(res)
        res.status(201).json(await reject(deps.pool, deps, { ...target(res, p), reason: body.reason }))
      },
    ],
  })

  table.add({
    method: 'post',
    path: `${base}/changes`,
    access: { kind: 'permission', permission: 'approve_content' },
    summary:
      'Ask for changes to a version awaiting approval, with a comment; a strategy brief is then rewritten from it',
    handlers: [
      validate({ params, body: changesBody }),
      async (_req, res) => {
        const { params: p, body } = inputOf<{ params: P; body: z.infer<typeof changesBody> }>(res)
        res
          .status(201)
          .json(await askForChanges(deps.pool, deps, { ...target(res, p), comment: body.comment }))
      },
    ],
  })

  table.add({
    method: 'post',
    path: `${base}/comments`,
    access: { kind: 'permission', permission: 'approve_content' },
    summary: 'Comment on a version; the comment is kept in the audit log',
    handlers: [
      validate({ params, body: commentBody }),
      async (_req, res) => {
        const { params: p, body } = inputOf<{ params: P; body: z.infer<typeof commentBody> }>(res)
        await comment(deps.pool, deps, { ...target(res, p), text: body.text })
        res.status(201).json({ ok: true })
      },
    ],
  })
}
