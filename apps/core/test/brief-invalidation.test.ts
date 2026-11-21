import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { briefWorld, day, type BriefWorld, type MadeBrief } from './brief-support.ts'

// Task 7 of M11 (spec 10, app flow 5.6): a brief rests on the facts it cites. A citation is current while the brand
// has a fact in force with the cited wording (its text hash). When a cited fact is reworded or retired, a brief
// waiting for approval, approved or scheduled is invalidated: an approved one's approval is cancelled
// (approval_invalidation), the platform owners are told, and gate 1 is off until a new brief is approved. A change
// of the review date alone keeps the wording, so it changes nothing. Approving a brief checks its citations again.

let w: BriefWorld
beforeAll(async () => {
  w = await briefWorld('invalidation')
}, 120_000)
afterAll(async () => w?.stack.close())

const approve = (made: MadeBrief) =>
  w.owner.request('POST', w.contentApi(made.brandId, `/${made.itemId}/versions/${made.versionId}/approve`), {
    body: { hash: made.hash, hash_scheme: 'cv1' },
  })
const replace = (brandId: string, factId: string, statement: string, reviewDate: string) =>
  w.owner.request('POST', w.api(brandId, `/facts/${factId}/replace`), { body: { statement, reviewDate } })
const retire = (brandId: string, factId: string) =>
  w.owner.request('POST', w.api(brandId, `/facts/${factId}/retire`), { body: {} })
const told = async (brandId: string, versionId: string) =>
  (
    await w.q(
      `select user_id from app.notification
        where brand_id = $1 and kind = 'brief_needs_reapproval' and subject_kind = 'content_version'
          and subject_id = $2 order by user_id`,
      [brandId, versionId],
    )
  ).map((r) => r.user_id as string)
const invalidatedAudits = async (brandId: string) =>
  (
    await w.q(
      `select actor_id, subject, detail from audit.log
        where brand_id = $1 and action = 'approval.invalidated' order by seq`,
      [brandId],
    )
  ).map((r) => ({ actor: r.actor_id, subject: r.subject, detail: r.detail }))
const invalidations = (brandId: string) =>
  w.q('select approval_id, reason from app.approval_invalidation where brand_id = $1', [brandId])
const cause = async (versionId: string) =>
  w.q(
    `select from_state, cause from app.content_version_state_change
      where content_version_id = $1 and to_state = 'invalidated'`,
    [versionId],
  )

describe('a changed fact cancels the brief', () => {
  it('rewording a cited fact invalidates the approved brief', async () => {
    const made = await w.withBrief({ team: true })
    const approved = await approve(made)
    expect(approved.status, JSON.stringify(approved.json)).toBe(201)
    expect(await w.stepOf(made.brandId)).toBe('done')
    expect((await w.overview(made.brandId)).gate1).toBe(true)

    const replaced = await replace(made.brandId, made.factId, 'Open since 2018.', day(120))
    expect(replaced.status, JSON.stringify(replaced.json)).toBe(200)

    expect(await w.stateOf(made.versionId)).toBe('invalidated')
    expect(await cause(made.versionId)).toEqual([{ from_state: 'approved', cause: 'fact_changed' }])
    // The approval is cancelled, not deleted.
    expect(await invalidations(made.brandId)).toEqual([
      { approval_id: approved.json.approvalId, reason: 'fact_changed' },
    ])
    expect(await w.q('select 1 from app.approval where id = $1', [approved.json.approvalId])).toHaveLength(1)
    // The platform owners are told; the brand's admin and approver cannot decide on a brief, so they are not.
    const owners = await w.platformOwners()
    expect(await told(made.brandId, made.versionId)).toEqual(owners)
    expect(owners).toContain(w.ownerId)
    expect(owners).not.toContain(w.adminId)
    expect(await invalidatedAudits(made.brandId)).toEqual([
      {
        actor: w.ownerId,
        subject: made.versionId,
        detail: { versionId: made.versionId, factId: made.factId },
      },
    ])
    // Gate 1 is off; the brand stays onboarded.
    const seen = await w.overview(made.brandId)
    expect(seen.brief).toMatchObject({
      versionId: made.versionId,
      state: 'invalidated',
      needsDecision: false,
    })
    expect(seen.gate1).toBe(false)
    expect(seen.step).toBe('done')
  })

  it('a date-only replacement keeps the brief approved', async () => {
    const made = await w.withBrief()
    expect((await approve(made)).status).toBe(201)
    const moved = await replace(made.brandId, made.factId, 'Open since 2019.', day(200))
    expect(moved.status, JSON.stringify(moved.json)).toBe(200)
    expect(moved.json.factId).not.toBe(made.factId)

    expect(await w.stateOf(made.versionId)).toBe('approved')
    expect(await invalidations(made.brandId)).toEqual([])
    expect(await told(made.brandId, made.versionId)).toEqual([])
    expect(await invalidatedAudits(made.brandId)).toEqual([])
    expect((await w.overview(made.brandId)).gate1).toBe(true)

    // The brief still cites the first fact's id; rewording the fact that replaced it changes the cited wording.
    const reworded = await replace(made.brandId, moved.json.factId, 'Open since 2017.', day(200))
    expect(reworded.status).toBe(200)
    expect(await w.stateOf(made.versionId)).toBe('invalidated')
    expect(await invalidations(made.brandId)).toHaveLength(1)
    expect((await invalidatedAudits(made.brandId)).map((a) => a.detail)).toEqual([
      { versionId: made.versionId, factId: moved.json.factId },
    ])
    expect((await w.overview(made.brandId)).gate1).toBe(false)
  })

  it('retiring a fact cited by a waiting brief invalidates it', async () => {
    const made = await w.withBrief()
    // A fact the brief does not cite: retiring it changes nothing.
    const other = await w.owner.request('POST', w.api(made.brandId, '/facts'), {
      body: { statement: 'Two studios in Pune.', reviewDate: day(90) },
    })
    expect(other.status).toBe(200)
    expect((await retire(made.brandId, other.json.factId)).status).toBe(200)
    expect(await w.stateOf(made.versionId)).toBe('awaiting_approval')

    expect((await retire(made.brandId, made.factId)).status).toBe(200)
    expect(await w.stateOf(made.versionId)).toBe('invalidated')
    expect(await cause(made.versionId)).toEqual([{ from_state: 'awaiting_approval', cause: 'fact_changed' }])
    // Nothing was approved, so there is no approval to cancel; the request is closed.
    expect(await invalidations(made.brandId)).toEqual([])
    expect(
      (
        await w.q('select closed_at from app.approval_request where content_version_id = $1', [
          made.versionId,
        ])
      )[0].closed_at,
    ).not.toBeNull()
    expect(await told(made.brandId, made.versionId)).toEqual(await w.platformOwners())
    expect((await invalidatedAudits(made.brandId)).map((a) => a.detail)).toEqual([
      { versionId: made.versionId, factId: made.factId },
    ])

    // It can no longer be approved.
    const approved = await approve(made)
    expect(approved.status).toBe(409)
    expect(approved.json).toMatchObject({ error: { code: 'not_awaiting_approval' } })
    expect(await w.q('select 1 from app.approval where content_version_id = $1', [made.versionId])).toEqual(
      [],
    )
    const seen = await w.overview(made.brandId)
    expect(seen.brief).toMatchObject({ state: 'invalidated' })
    expect(seen.gate1).toBe(false)
    expect(seen.step).toBe('brief')
  })

  it('approving a brief whose fact changed in between is refused with fact_changed', async () => {
    const made = await w.withBrief()
    // The fact leaves force behind the service's back (no replace or retire ran), so only the approval's own check
    // can see it.
    await w.q(`update app.verified_fact set status = 'expired' where id = $1`, [made.factId])

    const approved = await approve(made)
    expect(approved.status).toBe(409)
    expect(approved.json).toMatchObject({
      error: { code: 'fact_changed', message: 'A fact this brief cites changed. Ask for a new version.' },
    })
    expect(await w.q('select 1 from app.approval where content_version_id = $1', [made.versionId])).toEqual(
      [],
    )
    // The version is invalidated all the same, and the owners are told.
    expect(await w.stateOf(made.versionId)).toBe('invalidated')
    expect(await cause(made.versionId)).toEqual([{ from_state: 'awaiting_approval', cause: 'fact_changed' }])
    expect(await told(made.brandId, made.versionId)).toEqual(await w.platformOwners())
    expect((await invalidatedAudits(made.brandId)).map((a) => a.detail)).toEqual([
      { versionId: made.versionId, factId: made.factId },
    ])
    const refusals = await w.q(
      `select outcome, detail from audit.log where brand_id = $1 and action = 'approval.approved' order by seq`,
      [made.brandId],
    )
    expect(refusals).toEqual([{ outcome: 'failure', detail: { code: 'fact_changed' } }])
    expect(await w.stepOf(made.brandId)).toBe('brief')
    expect((await w.overview(made.brandId)).gate1).toBe(false)
  })
})
