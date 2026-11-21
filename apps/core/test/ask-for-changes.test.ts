import { withBrand } from '@mkt/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createVersion, moveState } from '../src/content/versions.ts'
import { briefWorld, type BriefWorld } from './brief-support.ts'
import type { TestClient } from './support.ts'

// Task 7 of M11 (app flow 5.6, spec 10): "ask for changes". The approver's comment closes the version (rejected,
// cause changes_requested) with an approval of decision changes_requested on the version's own hash. For a strategy
// brief, below the revision limit, the strategist starts again in the same transaction with the comment and the
// closed version's text; a refusal there keeps the decision and starts nothing. Only the platform owner may ask for
// changes on a brief.

let w: BriefWorld
beforeAll(async () => {
  w = await briefWorld('changes')
}, 120_000)
afterAll(async () => w?.stack.close())

const ask = (who: TestClient, brandId: string, itemId: string, versionId: string, comment: string) =>
  who.request('POST', w.contentApi(brandId, `/${itemId}/versions/${versionId}/changes`), {
    body: { comment },
  })
const audits = (brandId: string, action: string) =>
  w.q(
    `select actor_id, outcome, subject, detail from audit.log where brand_id = $1 and action = $2 order by seq`,
    [brandId, action],
  )
const strategistRuns = async (brandId: string) =>
  (
    await w.q(`select count(*)::int as n from app.run where brand_id = $1 and agent = 'strategist'`, [
      brandId,
    ])
  )[0].n as number

describe('ask for changes', () => {
  it('asking for changes closes the version and starts the strategist with the comment', async () => {
    const made = await w.withBrief()
    const reply = await ask(w.owner, made.brandId, made.itemId, made.versionId, '  Lead with fleets.  ')
    expect(reply.status, JSON.stringify(reply.json)).toBe(201)
    const { approvalId, runId } = reply.json as { approvalId: string; runId: string | null }
    expect(runId).toEqual(expect.any(String))

    // The decision: the comment on the hash that was shown, the version closed, its request closed.
    expect(
      await w.q(
        'select decision, comment, version_hash, hash_scheme, decided_by from app.approval where id = $1',
        [approvalId],
      ),
    ).toEqual([
      {
        decision: 'changes_requested',
        comment: 'Lead with fleets.',
        version_hash: made.hash,
        hash_scheme: 'cv1',
        decided_by: w.ownerId,
      },
    ])
    expect(await w.stateOf(made.versionId)).toBe('rejected')
    expect(
      await w.q(
        `select from_state, cause, actor_kind, actor_id from app.content_version_state_change
          where content_version_id = $1 and to_state = 'rejected'`,
        [made.versionId],
      ),
    ).toEqual([
      {
        from_state: 'awaiting_approval',
        cause: 'changes_requested',
        actor_kind: 'user',
        actor_id: w.ownerId,
      },
    ])
    expect(
      (
        await w.q('select closed_at from app.approval_request where content_version_id = $1', [
          made.versionId,
        ])
      )[0].closed_at,
    ).not.toBeNull()
    // Audited with ids and the revision only, never the comment.
    expect(await audits(made.brandId, 'approval.changes_requested')).toEqual([
      {
        actor_id: w.ownerId,
        outcome: 'success',
        subject: made.versionId,
        detail: { approvalId, revision: 0 },
      },
    ])

    // The strategist starts again with the comment and the closed version's text.
    expect(await w.q('select agent, state from app.run where id = $1', [runId])).toEqual([
      { agent: 'strategist', state: 'running' },
    ])
    const jobId = await w.jobOfRun(runId!)
    const input = await w.inputOf(jobId)
    expect(input.changeRequest?.comment).toBe('Lead with fleets.')
    expect(input.changeRequest?.previous.split('\n')).toContain('Ceramic coatings that keep a new car new.')
    expect((await audits(made.brandId, 'onboarding.brief_started')).map((r) => r.detail)).toEqual([
      { runId: made.runId, revision: 0 },
      { runId, revision: 1 },
    ])
    expect(await audits(made.brandId, 'onboarding.brief_revision_not_started')).toEqual([])
    // The overview shows the closed version and the rewrite waiting to run.
    expect((await w.overview(made.brandId)).brief).toMatchObject({
      versionId: made.versionId,
      state: 'rejected',
      revision: 0,
      needsDecision: false,
      job: { state: 'waiting' },
    })

    // A second ask on the closed version is refused; the comment is not taken twice.
    const again = await ask(w.owner, made.brandId, made.itemId, made.versionId, 'And shorter.')
    expect(again.status).toBe(409)
    expect(again.json).toMatchObject({ error: { code: 'already_decided' } })
    expect(await strategistRuns(made.brandId)).toBe(2)

    // The rewrite arrives as the next revision, waiting for approval.
    await w.post(jobId, w.result([made.factId], 'Fleets first.'))
    const next = await w.currentBrief(made.brandId)
    expect(next.state).toBe('awaiting_approval')
    expect((await w.overview(made.brandId)).brief).toMatchObject({
      versionId: next.versionId,
      number: 2,
      revision: 1,
      needsDecision: false,
      job: { state: 'done' },
    })
  })

  it('after three revisions an ask for changes starts no new run', async () => {
    const made = await w.withBrief()
    let current = made.versionId
    for (let revision = 1; revision <= 3; revision += 1) {
      const reply = await ask(w.owner, made.brandId, made.itemId, current, `Change number ${revision}.`)
      expect(reply.status, JSON.stringify(reply.json)).toBe(201)
      const runId = reply.json.runId as string
      expect(runId).toEqual(expect.any(String))
      await w.post(await w.jobOfRun(runId), w.result([made.factId], `Line ${revision}.`))
      const next = await w.currentBrief(made.brandId)
      expect((await w.overview(made.brandId)).brief).toMatchObject({
        versionId: next.versionId,
        state: 'awaiting_approval',
        revision,
        needsDecision: false,
      })
      current = next.versionId
    }
    expect(await strategistRuns(made.brandId)).toBe(4)

    // The fourth ask records the comment and closes the version, and starts nothing.
    const fourth = await ask(w.owner, made.brandId, made.itemId, current, 'Once more.')
    expect(fourth.status, JSON.stringify(fourth.json)).toBe(201)
    expect(fourth.json).toEqual({ approvalId: expect.any(String), runId: null })
    expect(await strategistRuns(made.brandId)).toBe(4)
    expect(await w.stateOf(current)).toBe('rejected')
    expect(
      await w.q('select decision, comment from app.approval where id = $1', [fourth.json.approvalId]),
    ).toEqual([{ decision: 'changes_requested', comment: 'Once more.' }])
    const seen = await w.overview(made.brandId)
    expect(seen.brief).toMatchObject({
      versionId: current,
      state: 'rejected',
      revision: 3,
      needsDecision: true,
    })
    expect(seen.gate1).toBe(false)
    expect((await audits(made.brandId, 'approval.changes_requested')).map((r) => r.detail.revision)).toEqual([
      0, 1, 2, 3,
    ])
  })

  it('a refusal to start the next revision keeps the decision and starts nothing', async () => {
    // The queue is full: the run would be written before the job is refused, so only the savepoint removes it.
    const busy = await w.withBrief()
    const limit = w.jobs.backlogLimit
    w.jobs.backlogLimit = 0
    const reply = await ask(w.owner, busy.brandId, busy.itemId, busy.versionId, 'Lead with fleets.').finally(
      () => {
        w.jobs.backlogLimit = limit
      },
    )
    expect(reply.status, JSON.stringify(reply.json)).toBe(201)
    expect(reply.json).toEqual({ approvalId: expect.any(String), runId: null })
    expect(await w.stateOf(busy.versionId)).toBe('rejected')
    expect(
      await w.q('select decision from app.approval where content_version_id = $1', [busy.versionId]),
    ).toEqual([{ decision: 'changes_requested' }])
    expect(await strategistRuns(busy.brandId)).toBe(1)
    expect(await w.q('select 1 from app.job_input where brand_id = $1', [busy.brandId])).toHaveLength(1)
    expect(await audits(busy.brandId, 'onboarding.brief_revision_not_started')).toEqual([
      { actor_id: w.ownerId, outcome: 'failure', subject: busy.versionId, detail: { reason: 'queue_busy' } },
    ])
    expect(await audits(busy.brandId, 'onboarding.brief_started')).toHaveLength(1)

    // The strategist has no live release.
    const down = await w.withBrief()
    await w.q(`update app.agent_definition_version set live = false where agent = 'strategist'`)
    const unreleased = await ask(
      w.owner,
      down.brandId,
      down.itemId,
      down.versionId,
      'Lead with fleets.',
    ).finally(() => w.q(`update app.agent_definition_version set live = true where agent = 'strategist'`))
    expect(unreleased.status).toBe(201)
    expect(unreleased.json.runId).toBeNull()
    expect(await w.stateOf(down.versionId)).toBe('rejected')
    expect(
      (await audits(down.brandId, 'onboarding.brief_revision_not_started')).map((r) => r.detail),
    ).toEqual([{ reason: 'agent_unavailable' }])
    expect((await w.overview(down.brandId)).brief).toMatchObject({ state: 'rejected', needsDecision: false })
  })

  it('an ask for changes on another kind keeps the comment only', async () => {
    const { brandId } = await w.fresh({ team: true })
    const item = (
      await w.q(`insert into app.content_item (brand_id, kind) values ($1, 'article') returning id`, [
        brandId,
      ])
    )[0].id as string
    const version = await withBrand(w.stack.appPool, brandId, async (client) => {
      const actor = { kind: 'user' as const, userId: w.ownerId }
      const v = await createVersion(client, w.jobs, {
        brandId,
        contentItemId: item,
        payload: {
          kind: 'article',
          language: 'en',
          title: 'T',
          body: [{ type: 'paragraph', text: 'Hello' }],
        },
        createdBy: actor,
      })
      await moveState(client, w.jobs, v.versionId, 'in_checks', actor)
      await moveState(client, w.jobs, v.versionId, 'awaiting_approval', actor)
      return v
    })
    // A comment is needed.
    for (const body of [{ comment: '   ' }, {}, { comment: 'x'.repeat(2001) }]) {
      const bad = await w.approver.request(
        'POST',
        w.contentApi(brandId, `/${item}/versions/${version.versionId}/changes`),
        { body },
      )
      expect(bad.status).toBe(400)
    }
    const reply = await ask(w.approver, brandId, item, version.versionId, 'Shorter, please.')
    expect(reply.status, JSON.stringify(reply.json)).toBe(201)
    expect(reply.json).toEqual({ approvalId: expect.any(String), runId: null })
    expect(
      await w.q(
        'select decision, comment, version_hash, decided_by from app.approval where content_version_id = $1',
        [version.versionId],
      ),
    ).toEqual([
      {
        decision: 'changes_requested',
        comment: 'Shorter, please.',
        version_hash: version.hash,
        decided_by: w.approverId,
      },
    ])
    expect(await w.stateOf(version.versionId)).toBe('rejected')
    expect(await w.q('select 1 from app.run where brand_id = $1', [brandId])).toEqual([])
    expect((await audits(brandId, 'approval.changes_requested')).map((r) => r.detail)).toEqual([
      { approvalId: reply.json.approvalId, revision: null },
    ])
  })

  it('a brand admin cannot ask for changes on a brief', async () => {
    const made = await w.withBrief({ team: true })
    for (const who of [w.admin, w.approver]) {
      const reply = await ask(who, made.brandId, made.itemId, made.versionId, 'Lead with fleets.')
      expect(reply.status).toBe(403)
      expect(reply.json).toMatchObject({ error: { code: 'forbidden' } })
    }
    expect(await w.stateOf(made.versionId)).toBe('awaiting_approval')
    expect(await w.q('select 1 from app.approval where content_version_id = $1', [made.versionId])).toEqual(
      [],
    )
    expect(await strategistRuns(made.brandId)).toBe(1)
    expect(await audits(made.brandId, 'approval.changes_requested')).toEqual(
      [w.adminId, w.approverId].map((userId) => ({
        actor_id: userId,
        outcome: 'failure',
        subject: made.versionId,
        detail: { code: 'forbidden' },
      })),
    )
  })
})
