import type { PoolClient } from '@mkt/db'
import { enqueueNotification } from '../notify/notifications.ts'
import { platformOwnersOf } from '../notify/recipients.ts'
import type { VersionState } from './states.ts'
import { moveState, type Actor, type VersionDeps } from './versions.ts'

// Facts in the brief (spec 10, app flow 5.6). A version cites facts in its payload's fact_refs, each as
// { fact_id, text_hash: 'sha256:' || fact_hash }. A citation is current while the brand has a fact in force whose
// 'sha256:' || fact_hash is its text_hash: a replacement that only moves the review date keeps the wording (and the
// hash), so it keeps the citation current; a new wording or a retirement does not. A version that rests on a citation
// no longer current loses its standing: waiting, it can no longer be approved; approved or scheduled, its approval is
// cancelled (approval_invalidation). The platform owners are told either way.
//
// Lock order (approvals/requests.ts): the callers hold the brand row (FOR SHARE) and the onboarding row; this takes
// the version state rows, then the approval request (closed when a waiting version leaves), notifications and the
// audit entries.

export const REAPPROVAL_KIND = 'brief_needs_reapproval'

// The states in which a version still stands on its citations.
const STANDING: readonly VersionState[] = ['awaiting_approval', 'approved', 'scheduled']

// True for a citation `r` (a fact_refs element) of version `v` that is no longer current.
const NOT_CURRENT = `not exists (
  select 1 from app.verified_fact f
   where f.brand_id = v.brand_id and f.status = 'active' and 'sha256:' || f.fact_hash = r->>'text_hash')`
const REFS = `jsonb_array_elements(coalesce(v.payload_canonical::jsonb -> 'fact_refs', '[]'::jsonb))`

// The fact id of the first citation of the version that is no longer current; null when every one is (or it cites
// none).
export async function staleCitation(
  client: PoolClient,
  brandId: string,
  versionId: string,
): Promise<string | null> {
  const found = await client.query<{ fact_id: string }>(
    `select r->>'fact_id' as fact_id
       from app.content_version v, ${REFS} r
      where v.brand_id = $1 and v.id = $2 and ${NOT_CURRENT}
      order by r->>'fact_id' limit 1`,
    [brandId, versionId],
  )
  return found.rows[0]?.fact_id ?? null
}

// Moves one standing version to invalidated: an approved or scheduled one's approval is cancelled with `reason`, the
// platform owners are told, and the move is audited with the version and the fact (ids only).
export async function invalidateVersion(
  client: PoolClient,
  deps: VersionDeps,
  input: {
    brandId: string
    versionId: string
    from: VersionState
    factId: string
    reason: 'fact_changed'
    actor: Actor
  },
): Promise<void> {
  await moveState(client, deps, input.versionId, 'invalidated', input.actor, input.reason)
  if (input.from === 'approved' || input.from === 'scheduled') {
    await client.query(
      `insert into app.approval_invalidation (brand_id, approval_id, reason)
       select brand_id, id, $3 from app.approval
        where brand_id = $1 and content_version_id = $2 and decision = 'approved'`,
      [input.brandId, input.versionId, input.reason],
    )
  }
  for (const userId of await platformOwnersOf(client)) {
    await enqueueNotification(client, {
      brandId: input.brandId,
      userId,
      kind: REAPPROVAL_KIND,
      subject: { kind: 'content_version', id: input.versionId },
    })
  }
  await deps.audit.record(
    {
      action: 'approval.invalidated',
      actor: input.actor.userId ?? null,
      subject: input.versionId,
      brandId: input.brandId,
      outcome: 'success',
      detail: { versionId: input.versionId, factId: input.factId },
    },
    client,
  )
}

// Called when a fact of the brand changed its wording or left force (replaceFact, retireFact), in their transaction.
// Every item's current version that cites the fact (by its id, or by its wording, which a review-date replacement
// carried to a new id) and stands on a citation no longer current is invalidated. Returns how many were.
export async function invalidateFactCitations(
  client: PoolClient,
  deps: VersionDeps,
  input: { brandId: string; factId: string; reason: 'fact_changed'; actor: Actor },
): Promise<number> {
  // The fact's id as the database writes it (the caller's may differ in case) and its wording's hash.
  const fact = await client.query<{ id: string; fact_hash: string }>(
    'select id::text as id, fact_hash from app.verified_fact where brand_id = $1 and id = $2',
    [input.brandId, input.factId],
  )
  if (!fact.rows[0]) return 0
  const factId = fact.rows[0].id
  const textHash = `sha256:${fact.rows[0].fact_hash}`
  // Only a version whose canonical text names the fact or its wording is parsed (a plain substring test first), and
  // each such payload is parsed once: the lateral subquery is kept apart (offset 0) so its cast is not copied into
  // both tests below.
  const found = await client.query<{ version_id: string; state: VersionState }>(
    `select v.id as version_id, s.state
       from app.content_item i
       join app.content_version v on v.brand_id = i.brand_id and v.id = i.current_version_id
       join app.content_version_state s on s.brand_id = v.brand_id and s.content_version_id = v.id
       cross join lateral (select v.payload_canonical::jsonb -> 'fact_refs' as refs offset 0) p
      where i.brand_id = $1 and s.state = any($4::app.version_state[])
        and (strpos(v.payload_canonical, $2) > 0 or strpos(v.payload_canonical, $3) > 0)
        and exists (select 1 from jsonb_array_elements(p.refs) r where r->>'fact_id' = $2 or r->>'text_hash' = $3)
        and exists (select 1 from jsonb_array_elements(p.refs) r where ${NOT_CURRENT})
      order by v.id
        for update of s`,
    [input.brandId, factId, textHash, STANDING],
  )
  if (found.rows.length === 0) return 0
  // The open requests of the waiting ones are closed by the moves below; they are taken now, before the first move
  // writes an audit entry, as the lock order puts requests before the chain.
  await client.query(
    `select 1 from app.approval_request
      where brand_id = $1 and content_version_id = any($2::uuid[]) and closed_at is null
      order by id for update`,
    [input.brandId, found.rows.map((row) => row.version_id)],
  )
  for (const row of found.rows) {
    await invalidateVersion(client, deps, {
      brandId: input.brandId,
      versionId: row.version_id,
      from: row.state,
      factId,
      reason: input.reason,
      actor: input.actor,
    })
  }
  return found.rows.length
}
