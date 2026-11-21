import { withBrand, type Pool, type PoolClient } from '@mkt/db'
import { grantFor, type Actor as Role } from '../access/permissions.ts'
import { moveState, type Actor, type VersionDeps } from '../content/versions.ts'
import type { VersionState } from '../content/states.ts'
import { AppError } from '../errors.ts'
import { lockOnboarding } from '../onboarding/suggestions.ts'

export interface ApprovalDeps extends VersionDeps {
  // For tests only: runs right after the approval row is inserted, so a test can make the decision fail
  // half way. Production never sets it.
  afterApprovalInsert?: () => void
}

export interface DecisionTarget {
  brandId: string
  itemId: string
  versionId: string
  actor: Actor & { userId: string }
  // The person's role in this brand (the route's access check found it): who may decide depends on the kind.
  role: Role
}

export const COMMENT_MAX = 2000

const notFound = () => new AppError(404, 'not_found', 'There is nothing at this address.')

interface Locked {
  state: VersionState
  hash: string
  hashScheme: string
}

// Locks the version state row so decisions on one version run one at a time. A version that is not the
// brand's (the row is invisible) or not the item's is a 404.
async function lockVersion(client: PoolClient, target: DecisionTarget): Promise<Locked> {
  const found = await client.query<{ state: VersionState; hash: string; hash_scheme: string }>(
    `select s.state, v.hash, v.hash_scheme
       from app.content_version_state s
       join app.content_version v on v.id = s.content_version_id and v.brand_id = s.brand_id
      where s.content_version_id = $1 and s.brand_id = $2 and v.content_item_id = $3
        for update of s`,
    [target.versionId, target.brandId, target.itemId],
  )
  const row = found.rows[0]
  if (!row) throw notFound()
  return { state: row.state, hash: row.hash, hashScheme: row.hash_scheme }
}

// A strategy brief is decided by the platform owner alone (the holder of onboard_brand), never by the brand's
// approvers or admins, whatever approve_content gives them elsewhere.
const OWNER_DECIDES: ReadonlySet<string> = new Set(['strategy_brief'])

// Before any lock: the item's kind (it never changes) says who may decide, so a person who may not is refused
// whatever the version's state. A brief's decision changes onboarding, so for a brief the onboarding row is locked
// first, in the order the strategist's result takes them (onboarding, then the content rows). Then the version.
// Ask for changes (Task 7) decides the same way.
export async function lockForDecision(
  client: PoolClient,
  target: DecisionTarget,
): Promise<Locked & { kind: string }> {
  const found = await client.query<{ kind: string }>(
    `select i.kind from app.content_item i
       join app.content_version v on v.brand_id = i.brand_id and v.content_item_id = i.id
      where i.brand_id = $1 and i.id = $2 and v.id = $3`,
    [target.brandId, target.itemId, target.versionId],
  )
  const kind = found.rows[0]?.kind
  if (kind === undefined) throw notFound()
  if (OWNER_DECIDES.has(kind)) {
    if (!grantFor(target.role, 'onboard_brand')) {
      throw new AppError(
        403,
        'forbidden',
        'Only the platform owner decides on a strategy brief. Ask them to review it.',
      )
    }
    await lockOnboarding(client, target.brandId)
  }
  return { ...(await lockVersion(client, target)), kind }
}

function requireAwaiting(state: VersionState): void {
  if (state === 'awaiting_approval') return
  if (state === 'approved' || state === 'rejected') {
    throw new AppError(409, 'already_decided', 'This version has already been decided.')
  }
  if (state === 'superseded') {
    throw new AppError(
      409,
      'stale_hash',
      'The content has changed since it was shown; review the new version.',
    )
  }
  throw new AppError(409, 'not_awaiting_approval', 'This version is not waiting for approval.')
}

// A refusal (a 409, or the 403 of a person who may not decide on this kind) is audited after the transaction has
// rolled back, so the failed attempt leaves nothing else.
async function auditRefusal(
  deps: ApprovalDeps,
  action: string,
  target: DecisionTarget,
  error: unknown,
): Promise<void> {
  if (!(error instanceof AppError) || (error.status !== 409 && error.status !== 403)) return
  try {
    await deps.audit.record({
      action,
      actor: target.actor.userId,
      subject: target.versionId,
      brandId: target.brandId,
      outcome: 'failure',
      detail: { code: error.code },
    })
  } catch {
    // The caller's 409 must not be replaced by a failure of the audit.
  }
}

export async function approve(
  pool: Pool,
  deps: ApprovalDeps,
  input: DecisionTarget & { hash: string; scheme: string },
): Promise<{ approvalId: string }> {
  try {
    return await withBrand(pool, input.brandId, async (client) => {
      const locked = await lockForDecision(client, input)
      requireAwaiting(locked.state)
      if (locked.hash !== input.hash || locked.hashScheme !== input.scheme) {
        throw new AppError(409, 'stale_hash', 'The content has changed since it was shown; review it again.')
      }
      const inserted = await client.query<{ id: string }>(
        `insert into app.approval (brand_id, content_version_id, version_hash, hash_scheme, decision, decided_by)
         values ($1, $2, $3, $4, 'approved', $5) returning id`,
        [input.brandId, input.versionId, locked.hash, locked.hashScheme, input.actor.userId],
      )
      const approvalId = inserted.rows[0]!.id
      deps.afterApprovalInsert?.()
      await moveState(client, deps, input.versionId, 'approved', input.actor, 'approval_decision')
      // The column is a uuid: the key `approval:<id>` is hashed into one, the same every time.
      await client.query(
        `insert into app.outbox_action (brand_id, kind, content_version_id, approval_id, state, idempotency_key)
         values ($1, 'none', $2, $3, 'confirmed', md5($4)::uuid)`,
        [input.brandId, input.versionId, approvalId, `approval:${approvalId}`],
      )
      await deps.audit.record(
        {
          action: 'approval.approved',
          actor: input.actor.userId,
          subject: input.versionId,
          brandId: input.brandId,
          outcome: 'success',
          detail: { approvalId, hash: locked.hash },
        },
        client,
      )
      if (locked.kind === 'strategy_brief') {
        // Gate 1 (spec 10): the approved brief completes onboarding, and a later brief's approval passes it again.
        await client.query(
          `update app.onboarding set step = 'done', completed_at = now()
            where brand_id = $1 and step in ('brief', 'done')`,
          [input.brandId],
        )
        await deps.audit.record(
          {
            action: 'onboarding.gate_passed',
            actor: input.actor.userId,
            subject: input.versionId,
            brandId: input.brandId,
            outcome: 'success',
            detail: { versionId: input.versionId },
          },
          client,
        )
      }
      return { approvalId }
    })
  } catch (error) {
    await auditRefusal(deps, 'approval.approved', input, error)
    throw error
  }
}

export async function reject(
  pool: Pool,
  deps: ApprovalDeps,
  input: DecisionTarget & { reason: string },
): Promise<{ approvalId: string }> {
  try {
    return await withBrand(pool, input.brandId, async (client) => {
      const locked = await lockForDecision(client, input)
      requireAwaiting(locked.state)
      const inserted = await client.query<{ id: string }>(
        `insert into app.approval
           (brand_id, content_version_id, version_hash, hash_scheme, decision, decided_by, comment)
         values ($1, $2, $3, $4, 'rejected', $5, $6) returning id`,
        [input.brandId, input.versionId, locked.hash, locked.hashScheme, input.actor.userId, input.reason],
      )
      const approvalId = inserted.rows[0]!.id
      await moveState(client, deps, input.versionId, 'rejected', input.actor, 'approval_decision')
      await deps.audit.record(
        {
          action: 'approval.rejected',
          actor: input.actor.userId,
          subject: input.versionId,
          brandId: input.brandId,
          outcome: 'success',
          detail: { approvalId, reason: input.reason },
        },
        client,
      )
      return { approvalId }
    })
  } catch (error) {
    await auditRefusal(deps, 'approval.rejected', input, error)
    throw error
  }
}

// The schema has no comment table (the comment column of approval belongs to a decision), so a comment is
// kept as an audit entry only.
export async function comment(
  pool: Pool,
  deps: ApprovalDeps,
  input: DecisionTarget & { text: string },
): Promise<void> {
  await withBrand(pool, input.brandId, async (client) => {
    await lockVersion(client, input)
    await deps.audit.record(
      {
        action: 'approval.commented',
        actor: input.actor.userId,
        subject: input.versionId,
        brandId: input.brandId,
        outcome: 'success',
        detail: { text: input.text },
      },
      client,
    )
  })
}
