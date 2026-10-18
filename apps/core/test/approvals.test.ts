import { withBrand } from '@mkt/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { approve, reject, type ApprovalDeps } from '../src/approvals/service.ts'
import { createVersion, moveState } from '../src/content/versions.ts'
import { AppError } from '../src/errors.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'

const body = (text = 'Hello there') => ({
  kind: 'article' as const,
  language: 'en',
  title: 'A title',
  body: [{ type: 'paragraph' as const, text }],
})

describe('approvals', () => {
  let stack: Stack
  let deps: ApprovalDeps
  let brandA: string
  let brandB: string
  let userId: string
  let approver: TestClient
  let viewer: TestClient
  let bAdmin: TestClient

  const actor = () => ({ kind: 'user' as const, userId })
  const target = (itemId: string, versionId: string, brandId = brandA) => ({
    brandId,
    itemId,
    versionId,
    actor: actor(),
  })
  // An item with one version waiting for approval.
  const waiting = async (text?: string) => {
    const item = (
      await stack.db.admin.query(
        `insert into app.content_item (brand_id, kind) values ($1, 'article') returning id`,
        [brandA],
      )
    ).rows[0].id as string
    const v = await withBrand(stack.appPool, brandA, async (client) => {
      const created = await createVersion(client, deps, {
        brandId: brandA,
        contentItemId: item,
        payload: body(text),
        createdBy: actor(),
      })
      await moveState(client, deps, created.versionId, 'in_checks', actor())
      await moveState(client, deps, created.versionId, 'awaiting_approval', actor())
      return created
    })
    return { item, ...v }
  }
  const count = async (table: string, versionId: string): Promise<number> =>
    (
      await stack.db.admin.query(
        `select count(*)::int as n from app.${table} where content_version_id = $1`,
        [versionId],
      )
    ).rows[0].n
  const stateOf = async (versionId: string): Promise<string> =>
    (
      await stack.db.admin.query(
        'select state from app.content_version_state where content_version_id = $1',
        [versionId],
      )
    ).rows[0].state as string
  const code = (e: unknown) => (e as AppError).code

  beforeAll(async () => {
    stack = await createStack()
    deps = { audit: stack.audit }
    brandA = await addBrand(stack, 'ap-a')
    brandB = await addBrand(stack, 'ap-b')
    userId = await addUser(stack, {
      email: 'ap@example.test',
      password: PASSWORD,
      role: 'approver',
      brandId: brandA,
    })
    await addUser(stack, { email: 'vw@example.test', password: PASSWORD, role: 'viewer', brandId: brandA })
    await addUser(stack, {
      email: 'ba@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brandB,
    })
    approver = (await enrolledClient(stack, 'ap@example.test', PASSWORD)).client
    viewer = (await enrolledClient(stack, 'vw@example.test', PASSWORD)).client
    bAdmin = (await enrolledClient(stack, 'ba@example.test', PASSWORD)).client
  })
  afterAll(async () => stack?.close())

  it('approves: one approval, state approved, a confirmed outbox action, request closed, audited (test 19 happy path)', async () => {
    const w = await waiting()
    const { approvalId } = await approve(stack.appPool, deps, {
      ...target(w.item, w.versionId),
      hash: w.hash,
      scheme: 'cv1',
    })
    expect(await stateOf(w.versionId)).toBe('approved')
    expect(await count('approval', w.versionId)).toBe(1)
    const outbox = await stack.db.admin.query(
      'select kind, state, approval_id from app.outbox_action where content_version_id = $1',
      [w.versionId],
    )
    expect(outbox.rows).toEqual([{ kind: 'none', state: 'confirmed', approval_id: approvalId }])
    const req = await stack.db.admin.query(
      'select closed_at from app.approval_request where content_version_id = $1',
      [w.versionId],
    )
    expect(req.rows[0].closed_at).not.toBeNull()
    const idx = stack.audit.entries.findIndex(
      (e) => e.action === 'approval.approved' && e.subject === w.versionId,
    )
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(stack.audit.transactional[idx]).toBe(true)
  })

  it('refuses the old hash after an edit: 409, no approval, the old version is superseded (test 18)', async () => {
    const w = await waiting('first')
    const two = await withBrand(stack.appPool, brandA, (client) =>
      createVersion(client, deps, {
        brandId: brandA,
        contentItemId: w.item,
        payload: body('second'),
        createdBy: actor(),
      }),
    )
    expect(await stateOf(w.versionId)).toBe('superseded')
    const error = await approve(stack.appPool, deps, {
      ...target(w.item, w.versionId),
      hash: w.hash,
      scheme: 'cv1',
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(409)
    expect(code(error)).toBe('stale_hash')
    expect(await count('approval', w.versionId)).toBe(0)
    expect(await count('approval', two.versionId)).toBe(0)
    expect(await stateOf(two.versionId)).toBe('draft')
    const failed = stack.audit.entries.filter(
      (e) => e.action === 'approval.approved' && e.subject === w.versionId && e.outcome === 'failure',
    )
    expect(failed).toHaveLength(1)
  })

  it('refuses a hash that differs from the stored one while the version is awaiting: 409 stale_hash, nothing written', async () => {
    const w = await waiting()
    const error = await approve(stack.appPool, deps, {
      ...target(w.item, w.versionId),
      hash: 'sha256:' + '0'.repeat(64),
      scheme: 'cv1',
    }).catch((e: unknown) => e)
    expect(code(error)).toBe('stale_hash')
    expect(await stateOf(w.versionId)).toBe('awaiting_approval')
    expect(await count('approval', w.versionId)).toBe(0)
    expect(await count('outbox_action', w.versionId)).toBe(0)
  })

  it('leaves nothing behind when the decision fails after the approval insert (test 19)', async () => {
    const w = await waiting()
    const failing: ApprovalDeps = {
      ...deps,
      afterApprovalInsert: () => {
        throw new Error('injected')
      },
    }
    const before = stack.audit.entries.length
    await expect(
      approve(stack.appPool, failing, { ...target(w.item, w.versionId), hash: w.hash, scheme: 'cv1' }),
    ).rejects.toThrow('injected')
    expect(await count('approval', w.versionId)).toBe(0)
    expect(await count('outbox_action', w.versionId)).toBe(0)
    expect(await stateOf(w.versionId)).toBe('awaiting_approval')
    const req = await stack.db.admin.query(
      'select closed_at from app.approval_request where content_version_id = $1',
      [w.versionId],
    )
    expect(req.rows[0].closed_at).toBeNull()
    expect(stack.audit.entries.slice(before).filter((e) => e.outcome === 'success')).toHaveLength(0)
  })

  it('serialises two simultaneous approvals: one approval, one outbox row, the loser gets 409 already_decided', async () => {
    const w = await waiting()
    const go = () =>
      approve(stack.appPool, deps, { ...target(w.item, w.versionId), hash: w.hash, scheme: 'cv1' }).then(
        () => 'ok',
        (e: unknown) => e as AppError,
      )
    const results = await Promise.all([go(), go()])
    expect(results.filter((r) => r === 'ok')).toHaveLength(1)
    const loser = results.find((r) => r !== 'ok') as AppError
    expect(loser.status).toBe(409)
    expect(loser.code).toBe('already_decided')
    expect(await count('approval', w.versionId)).toBe(1)
    expect(await count('outbox_action', w.versionId)).toBe(1)
  })

  it('rejects with a reason: approval row rejected, state rejected, no outbox action, audited', async () => {
    const w = await waiting()
    await reject(stack.appPool, deps, { ...target(w.item, w.versionId), reason: 'Tone is off' })
    expect(await stateOf(w.versionId)).toBe('rejected')
    const rows = await stack.db.admin.query(
      'select decision, comment from app.approval where content_version_id = $1',
      [w.versionId],
    )
    expect(rows.rows).toEqual([{ decision: 'rejected', comment: 'Tone is off' }])
    expect(await count('outbox_action', w.versionId)).toBe(0)
    expect(
      stack.audit.entries.some(
        (e) => e.action === 'approval.rejected' && e.subject === w.versionId && e.outcome === 'success',
      ),
    ).toBe(true)
    const again = await reject(stack.appPool, deps, { ...target(w.item, w.versionId), reason: 'x' }).catch(
      (e: unknown) => e,
    )
    expect(code(again)).toBe('already_decided')
  })

  it('answers 404 for a version of another item or another brand', async () => {
    const w = await waiting()
    const other = await waiting()
    const wrongItem = await approve(stack.appPool, deps, {
      ...target(other.item, w.versionId),
      hash: w.hash,
      scheme: 'cv1',
    }).catch((e: unknown) => e)
    expect((wrongItem as AppError).status).toBe(404)
    const wrongBrand = await approve(stack.appPool, deps, {
      ...target(w.item, w.versionId, brandB),
      hash: w.hash,
      scheme: 'cv1',
    }).catch((e: unknown) => e)
    expect((wrongBrand as AppError).status).toBe(404)
    expect(await stateOf(w.versionId)).toBe('awaiting_approval')
  })

  it('does not carry an approval over to the next version after an edit (test 18)', async () => {
    const w = await waiting('one')
    await approve(stack.appPool, deps, { ...target(w.item, w.versionId), hash: w.hash, scheme: 'cv1' })
    expect(await stateOf(w.versionId)).toBe('approved')
    const two = await withBrand(stack.appPool, brandA, async (client) => {
      const created = await createVersion(client, deps, {
        brandId: brandA,
        contentItemId: w.item,
        payload: body('two'),
        createdBy: actor(),
      })
      await moveState(client, deps, created.versionId, 'in_checks', actor())
      await moveState(client, deps, created.versionId, 'awaiting_approval', actor())
      return created
    })
    expect(await stateOf(w.versionId)).toBe('superseded')
    expect(await count('approval', w.versionId)).toBe(1)
    expect(await count('approval', two.versionId)).toBe(0)
    expect(await count('outbox_action', two.versionId)).toBe(0)
    expect(await stateOf(two.versionId)).toBe('awaiting_approval')
    const error = await approve(stack.appPool, deps, {
      ...target(w.item, two.versionId),
      hash: w.hash,
      scheme: 'cv1',
    }).catch((e: unknown) => e)
    expect((error as AppError).status).toBe(409)
    expect(code(error)).toBe('stale_hash')
    expect(await count('approval', two.versionId)).toBe(0)
    expect(await stateOf(two.versionId)).toBe('awaiting_approval')
  })

  it('answers already_decided to a second approval of an approved version, even with a wrong hash', async () => {
    const w = await waiting()
    await approve(stack.appPool, deps, { ...target(w.item, w.versionId), hash: w.hash, scheme: 'cv1' })
    const error = await approve(stack.appPool, deps, {
      ...target(w.item, w.versionId),
      hash: 'sha256:' + '0'.repeat(64),
      scheme: 'cv1',
    }).catch((e: unknown) => e)
    expect((error as AppError).status).toBe(409)
    expect(code(error)).toBe('already_decided')
    expect(await count('approval', w.versionId)).toBe(1)
  })

  it('keeps the 409 when the audit of the refusal fails', async () => {
    const w = await waiting()
    const broken: ApprovalDeps = {
      ...deps,
      audit: {
        record: async (entry, tx) => {
          if (entry.outcome === 'failure') throw new Error('audit down')
          return deps.audit.record(entry, tx)
        },
      },
    }
    const error = await approve(stack.appPool, broken, {
      ...target(w.item, w.versionId),
      hash: 'sha256:' + '1'.repeat(64),
      scheme: 'cv1',
    }).catch((e: unknown) => e)
    expect(code(error)).toBe('stale_hash')
  })

  it('refuses to decide a version that is not awaiting approval', async () => {
    const item = (
      await stack.db.admin.query(
        `insert into app.content_item (brand_id, kind) values ($1, 'article') returning id`,
        [brandA],
      )
    ).rows[0].id as string
    const v = await withBrand(stack.appPool, brandA, (client) =>
      createVersion(client, deps, {
        brandId: brandA,
        contentItemId: item,
        payload: body(),
        createdBy: actor(),
      }),
    )
    const error = await approve(stack.appPool, deps, {
      ...target(item, v.versionId),
      hash: v.hash,
      scheme: 'cv1',
    }).catch((e: unknown) => e)
    expect((error as AppError).status).toBe(409)
    expect(await count('approval', v.versionId)).toBe(0)
  })

  describe('routes', () => {
    const url = (brand: string, w: { item: string; versionId: string }, tail: string) =>
      `/api/v1/brands/${brand}/content/${w.item}/versions/${w.versionId}/${tail}`

    it('approves through the route; a viewer gets 403; another brand gets 404', async () => {
      const w = await waiting()
      const payload = { hash: w.hash, hash_scheme: 'cv1' }
      expect((await viewer.request('POST', url(brandA, w, 'approve'), { body: payload })).status).toBe(403)
      expect((await bAdmin.request('POST', url(brandA, w, 'approve'), { body: payload })).status).toBe(404)
      expect(await stateOf(w.versionId)).toBe('awaiting_approval')
      const ok = await approver.request('POST', url(brandA, w, 'approve'), { body: payload })
      expect(ok.status).toBe(201)
      expect(await stateOf(w.versionId)).toBe('approved')
      const again = await approver.request('POST', url(brandA, w, 'approve'), { body: payload })
      expect(again.status).toBe(409)
      expect(again.json.error.code).toBe('already_decided')
    })

    it('rejects strict-body violations with 400', async () => {
      const w = await waiting()
      const post = (tail: string, b: unknown) => approver.request('POST', url(brandA, w, tail), { body: b })
      expect((await post('approve', { hash: w.hash, hash_scheme: 'cv2' })).status).toBe(400)
      expect((await post('approve', { hash: w.hash, hash_scheme: 'cv1', extra: 1 })).status).toBe(400)
      expect((await post('reject', {})).status).toBe(400)
      expect((await post('reject', { reason: '   ' })).status).toBe(400)
      expect((await post('comments', { text: 'x'.repeat(2001) })).status).toBe(400)
      expect(await stateOf(w.versionId)).toBe('awaiting_approval')
    })

    it('rejects and comments through the routes, audited', async () => {
      const w = await waiting()
      const c = await approver.request('POST', url(brandA, w, 'comments'), { body: { text: 'Looks fine' } })
      expect(c.status).toBe(201)
      expect(
        stack.audit.entries.some((e) => e.action === 'approval.commented' && e.subject === w.versionId),
      ).toBe(true)
      expect(await stateOf(w.versionId)).toBe('awaiting_approval')
      expect(
        (await viewer.request('POST', url(brandA, w, 'comments'), { body: { text: 'hi' } })).status,
      ).toBe(403)
      const r = await approver.request('POST', url(brandA, w, 'reject'), { body: { reason: 'No' } })
      expect(r.status).toBe(201)
      expect(await stateOf(w.versionId)).toBe('rejected')
    })
  })
})
