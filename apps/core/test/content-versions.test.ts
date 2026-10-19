import { PayloadRejected } from '@mkt/canonical'
import { withBrand } from '@mkt/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeRequest, openRequest } from '../src/approvals/requests.ts'
import { TRANSITIONS } from '../src/content/states.ts'
import { createVersion, moveState, type VersionDeps } from '../src/content/versions.ts'
import { AppError } from '../src/errors.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'
const ACTOR = { kind: 'user' as const, userId: '99999999-9999-4999-8999-999999999999' }

const body = (text = 'Hello there') => ({
  kind: 'article' as const,
  language: 'en',
  title: 'A title',
  body: [{ type: 'paragraph' as const, text }],
})

describe('content versions', () => {
  let stack: Stack
  let deps: VersionDeps
  let brandA: string
  let brandB: string
  let approver: TestClient
  let viewer: TestClient
  let salesless: TestClient
  let bAdmin: TestClient

  const newItem = async (brandId: string): Promise<string> =>
    (
      await stack.db.admin.query(
        `insert into app.content_item (brand_id, kind) values ($1, 'article') returning id`,
        [brandId],
      )
    ).rows[0].id as string
  const stateOf = async (versionId: string): Promise<string> =>
    (
      await stack.db.admin.query(
        'select state from app.content_version_state where content_version_id = $1',
        [versionId],
      )
    ).rows[0].state as string
  const create = (brandId: string, itemId: string, text?: string) =>
    withBrand(stack.appPool, brandId, (client) =>
      createVersion(client, deps, { brandId, contentItemId: itemId, payload: body(text), createdBy: ACTOR }),
    )
  const move = (brandId: string, versionId: string, to: Parameters<typeof moveState>[3]) =>
    withBrand(stack.appPool, brandId, (client) => moveState(client, deps, versionId, to, ACTOR))
  const request = async (versionId: string) =>
    (
      await stack.db.admin.query('select * from app.approval_request where content_version_id = $1', [
        versionId,
      ])
    ).rows[0] as { closed_at: Date | null } | undefined

  beforeAll(async () => {
    stack = await createStack()
    deps = { audit: stack.audit }
    brandA = await addBrand(stack, 'cv-a')
    brandB = await addBrand(stack, 'cv-b')
    await addUser(stack, { email: 'ap@example.test', password: PASSWORD, role: 'approver', brandId: brandA })
    await addUser(stack, { email: 'vw@example.test', password: PASSWORD, role: 'viewer', brandId: brandA })
    await addUser(stack, {
      email: 'sc@example.test',
      password: PASSWORD,
      role: 'sales_contact',
      brandId: brandA,
    })
    await addUser(stack, {
      email: 'ba@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brandB,
    })
    approver = (await enrolledClient(stack, 'ap@example.test', PASSWORD)).client
    viewer = (await enrolledClient(stack, 'vw@example.test', PASSWORD)).client
    salesless = (await enrolledClient(stack, 'sc@example.test', PASSWORD)).client
    bAdmin = (await enrolledClient(stack, 'ba@example.test', PASSWORD)).client
  })
  afterAll(async () => stack?.close())

  it('keeps the application transition list equal to the database table', async () => {
    const rows = (
      await stack.db.admin.query('select from_state, to_state from app.version_state_transition')
    ).rows.map((r: { from_state: string; to_state: string }) => `${r.from_state}>${r.to_state}`)
    expect([...TRANSITIONS].map(([a, b]) => `${a}>${b}`).sort()).toEqual(rows.sort())
  })

  it('numbers versions 1 and 2, supersedes the first, points the item at the second and audits both', async () => {
    const item = await newItem(brandA)
    const one = await create(brandA, item)
    const two = await create(brandA, item, 'A second text')
    expect([one.number, two.number]).toEqual([1, 2])
    expect(one.hash).not.toBe(two.hash)
    expect(await stateOf(one.versionId)).toBe('superseded')
    expect(await stateOf(two.versionId)).toBe('draft')
    const current = await stack.db.admin.query(
      'select current_version_id from app.content_item where id = $1',
      [item],
    )
    expect(current.rows[0].current_version_id).toBe(two.versionId)
    const actions = stack.audit.entries.map((e) => e.action)
    expect(actions.filter((a) => a === 'content.version_created').length).toBeGreaterThanOrEqual(2)
    const changed = stack.audit.entries.filter(
      (e) => e.action === 'content.state_changed' && e.subject === one.versionId,
    )
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({
      brandId: brandA,
      outcome: 'success',
      detail: { from: 'draft', to: 'superseded' },
    })
    const idx = stack.audit.entries.findIndex(
      (e) => e.action === 'content.version_created' && e.subject === two.versionId,
    )
    expect(stack.audit.transactional[idx]).toBe(true)
  })

  it('does not supersede a previous version that is no longer open', async () => {
    const item = await newItem(brandA)
    const one = await create(brandA, item)
    await move(brandA, one.versionId, 'in_checks')
    await move(brandA, one.versionId, 'awaiting_approval')
    // awaiting_approval is open; simulate a decided version by walking it to rejected.
    await move(brandA, one.versionId, 'rejected')
    const before = stack.audit.entries.length
    const two = await create(brandA, item, 'again')
    expect(await stateOf(one.versionId)).toBe('rejected')
    expect(two.number).toBe(2)
    const added = stack.audit.entries.slice(before).map((e) => e.action)
    expect(added).toEqual(['content.version_created'])
  })

  it('serialises two simultaneous edits: numbers 1 and 2, the first superseded once, one audit entry', async () => {
    const item = await newItem(brandA)
    const results = await Promise.all([create(brandA, item, 'left'), create(brandA, item, 'right')])
    expect(results.map((r) => r.number).sort()).toEqual([1, 2])
    const first = results.find((r) => r.number === 1)!
    const second = results.find((r) => r.number === 2)!
    expect(await stateOf(first.versionId)).toBe('superseded')
    expect(await stateOf(second.versionId)).toBe('draft')
    const moves = await stack.db.admin.query(
      `select count(*)::int as n from app.content_version_state_change
        where content_version_id = $1 and to_state = 'superseded'`,
      [first.versionId],
    )
    expect(moves.rows[0].n).toBe(1)
    const audited = stack.audit.entries.filter(
      (e) => e.action === 'content.state_changed' && e.subject === first.versionId,
    )
    expect(audited).toHaveLength(1)
    const current = await stack.db.admin.query(
      'select current_version_id from app.content_item where id = $1',
      [item],
    )
    expect(current.rows[0].current_version_id).toBe(second.versionId)
  })

  it('does not move a version of another brand: 404 and nothing changed', async () => {
    const item = await newItem(brandA)
    const v = await create(brandA, item)
    const before = stack.audit.entries.length
    const error = await move(brandB, v.versionId, 'in_checks').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(404)
    expect(await stateOf(v.versionId)).toBe('draft')
    expect(stack.audit.entries).toHaveLength(before)
  })

  it('rejects an invisible character with the path and stores nothing', async () => {
    const item = await newItem(brandA)
    const error = await create(brandA, item, 'bad​text').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PayloadRejected)
    expect((error as PayloadRejected).path).toMatch(/^body/)
    const n = await stack.db.admin.query(
      'select count(*)::int as n from app.content_version where content_item_id = $1',
      [item],
    )
    expect(n.rows[0].n).toBe(0)
  })

  it('refuses a disallowed transition and writes nothing', async () => {
    const item = await newItem(brandA)
    const v = await create(brandA, item)
    const error = await move(brandA, v.versionId, 'published').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(409)
    expect(await stateOf(v.versionId)).toBe('draft')
    const n = await stack.db.admin.query(
      'select count(*)::int as n from app.content_version_state_change where content_version_id = $1',
      [v.versionId],
    )
    expect(n.rows[0].n).toBe(1) // only the creation
  })

  it('opens an approval request on entering awaiting_approval and closes it on leaving', async () => {
    const item = await newItem(brandA)
    const v = await create(brandA, item)
    await move(brandA, v.versionId, 'in_checks')
    expect(await request(v.versionId)).toBeUndefined()
    await move(brandA, v.versionId, 'awaiting_approval')
    expect((await request(v.versionId))?.closed_at).toBeNull()
    // The database refuses `approved` without an approving decision on record (milestone 6, follow-up M-7).
    await stack.db.admin.query(
      `insert into app.approval (brand_id, content_version_id, version_hash, hash_scheme, decision, decided_by)
       select v.brand_id, v.id, v.hash, v.hash_scheme, 'approved', (select auth_user.id from auth."user" auth_user limit 1)
         from app.content_version v where v.id = $1`,
      [v.versionId],
    )
    await move(brandA, v.versionId, 'approved')
    expect((await request(v.versionId))?.closed_at).not.toBeNull()
  })

  it('closes the request when a new version supersedes one awaiting approval', async () => {
    const item = await newItem(brandA)
    const v = await create(brandA, item)
    await move(brandA, v.versionId, 'in_checks')
    await move(brandA, v.versionId, 'awaiting_approval')
    await create(brandA, item, 'newer')
    expect(await stateOf(v.versionId)).toBe('superseded')
    expect((await request(v.versionId))?.closed_at).not.toBeNull()
  })

  it('makes open and close idempotent', async () => {
    const item = await newItem(brandA)
    const v = await create(brandA, item)
    await withBrand(stack.appPool, brandA, async (client) => {
      await closeRequest(client, v.versionId, 'nothing open') // absent: no-op
      await openRequest(client, { brandId: brandA, versionId: v.versionId })
      await openRequest(client, { brandId: brandA, versionId: v.versionId })
      await closeRequest(client, v.versionId, 'done')
      await closeRequest(client, v.versionId, 'done again')
    })
    const rows = await stack.db.admin.query(
      'select closed_at from app.approval_request where content_version_id = $1',
      [v.versionId],
    )
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0].closed_at).not.toBeNull()
  })

  it('audits a state change inside the transaction', async () => {
    const item = await newItem(brandA)
    const v = await create(brandA, item)
    await move(brandA, v.versionId, 'in_checks')
    const idx = stack.audit.entries.findLastIndex(
      (e) => e.action === 'content.state_changed' && e.subject === v.versionId,
    )
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(stack.audit.transactional[idx]).toBe(true)
  })

  describe('routes', () => {
    const base = (brand: string) => `/api/v1/brands/${brand}/content`
    const payload = () => body('From the route')

    it('creates a version through the edit route and shows it in the detail and list', async () => {
      const item = await newItem(brandA)
      const reply = await approver.request('POST', `${base(brandA)}/${item}/versions`, { body: payload() })
      expect(reply.status).toBe(201)
      expect(reply.json).toMatchObject({ number: 1 })
      expect(reply.json.hash).toMatch(/^sha256:/)
      const detail = await viewer.request('GET', `${base(brandA)}/${item}`)
      expect(detail.status).toBe(200)
      expect(detail.json.versions).toHaveLength(1)
      expect(detail.json.versions[0]).toMatchObject({ number: 1, state: 'draft' })
      const list = await viewer.request('GET', base(brandA))
      expect(list.status).toBe(200)
      expect(list.json.items.find((i: { id: string }) => i.id === item)).toMatchObject({
        state: 'draft',
        number: 1,
      })
      const filtered = await viewer.request('GET', `${base(brandA)}?state=approved`)
      expect(filtered.json.items.find((i: { id: string }) => i.id === item)).toBeUndefined()
    })

    it('filters the inbox by overdue', async () => {
      const item = await newItem(brandA)
      const v = await create(brandA, item)
      await move(brandA, v.versionId, 'in_checks')
      await move(brandA, v.versionId, 'awaiting_approval')
      await stack.db.admin.query(
        'update app.approval_request set overdue = true where content_version_id = $1',
        [v.versionId],
      )
      const list = await viewer.request('GET', `${base(brandA)}?overdue=true`)
      expect(list.status).toBe(200)
      expect(list.json.items.map((i: { id: string }) => i.id)).toContain(item)
      expect(list.json.items.every((i: { overdue: boolean }) => i.overdue)).toBe(true)
    })

    it('lets a viewer read but not edit, and a sales contact do neither', async () => {
      const item = await newItem(brandA)
      expect((await viewer.request('GET', `${base(brandA)}/${item}`)).status).toBe(200)
      expect(
        (await viewer.request('POST', `${base(brandA)}/${item}/versions`, { body: payload() })).status,
      ).toBe(403)
      expect((await salesless.request('GET', base(brandA))).status).toBe(403)
    })

    it('answers 404 for another brand, and for an item that is not in the brand of the path', async () => {
      const item = await newItem(brandA)
      expect((await bAdmin.request('GET', `${base(brandA)}/${item}`)).status).toBe(404)
      expect(
        (await bAdmin.request('POST', `${base(brandA)}/${item}/versions`, { body: payload() })).status,
      ).toBe(404)
      expect((await bAdmin.request('GET', `${base(brandB)}/${item}`)).status).toBe(404)
      expect(
        (await bAdmin.request('POST', `${base(brandB)}/${item}/versions`, { body: payload() })).status,
      ).toBe(404)
    })

    it('rejects unknown fields, server-owned fields and an invisible character with 400, storing nothing', async () => {
      const item = await newItem(brandA)
      const count = async () =>
        (
          await stack.db.admin.query(
            'select count(*)::int as n from app.content_version where content_item_id = $1',
            [item],
          )
        ).rows[0].n
      const post = (b: unknown) => approver.request('POST', `${base(brandA)}/${item}/versions`, { body: b })
      expect((await post({ ...payload(), surprise: 1 })).status).toBe(400)
      expect((await post({ ...payload(), brand_id: brandB })).status).toBe(400)
      expect((await post({ ...payload(), content_item_id: item })).status).toBe(400)
      expect((await post({ ...payload(), schema: 'content-version/1' })).status).toBe(400)
      const bad = await post(body('bad​text'))
      expect(bad.status).toBe(400)
      expect(bad.json.error.code).toBe('payload_rejected')
      expect(bad.text).not.toContain('bad')
      expect(await count()).toBe(0)
    })

    it('rejects a payload whose kind differs from the item', async () => {
      const item = await newItem(brandA)
      const reply = await approver.request('POST', `${base(brandA)}/${item}/versions`, {
        body: { ...payload(), kind: 'email' },
      })
      expect(reply.status).toBe(400)
    })
  })
})
