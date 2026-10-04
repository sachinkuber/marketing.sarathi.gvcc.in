import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../src/errors.ts'
import { MemoryAudit } from '../src/testing.ts'
import { changeMemberRole, removeMember } from '../src/users/service.ts'
import { addBrand, addUser, createStack, type Stack } from './support.ts'

const PASSWORD = 'correct horse battery'
type AuditEntry = Parameters<MemoryAudit['record']>[0]

// An audit whose next role-change entry waits until the test lets it go, holding that transaction open.
class HeldAudit extends MemoryAudit {
  private gate: Promise<void> | null = null
  private open: (() => void) | null = null
  private reached: (() => void) | null = null
  arrived: Promise<void> = Promise.resolve()

  holdNext(): void {
    this.gate = new Promise((resolve) => (this.open = resolve))
    this.arrived = new Promise((resolve) => (this.reached = resolve))
  }

  release(): void {
    this.open?.()
  }

  override async record(entry: AuditEntry): Promise<void> {
    const gate = this.gate
    if (gate) {
      this.gate = null
      this.reached?.()
      await gate
    }
    await super.record(entry)
  }
}

// The actor's right to act is read from the session before the transaction. These tests prove the service
// checks it again under the lock, so an admin demoted or removed meanwhile cannot complete a change.
describe('the member services re-check the actor’s authority inside the lock', () => {
  let stack: Stack
  let audit: HeldAudit
  let brand: string
  let a: string
  let b: string
  let v: string
  let owner: string

  const roleOf = async (userId: string) =>
    (
      await stack.db.admin.query('select role from app.membership where brand_id = $1 and user_id = $2', [
        brand,
        userId,
      ])
    ).rows[0]?.role as string | undefined
  const setRole = (userId: string, role: string) =>
    stack.db.admin.query('update app.membership set role = $1 where brand_id = $2 and user_id = $3', [
      role,
      brand,
      userId,
    ])
  const refusal = async (work: Promise<unknown>) => {
    const error = await work.then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }

  beforeAll(async () => {
    audit = new HeldAudit()
    stack = await createStack({ audit })
    brand = await addBrand(stack, 'brand-a')
    a = await addUser(stack, {
      email: 'a@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brand,
    })
    b = await addUser(stack, {
      email: 'b@example.test',
      password: PASSWORD,
      role: 'brand_admin',
      brandId: brand,
    })
    v = await addUser(stack, { email: 'v@example.test', password: PASSWORD, role: 'viewer', brandId: brand })
    owner = await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
  })
  afterAll(async () => stack?.close())
  beforeEach(async () => {
    await setRole(a, 'brand_admin')
    await setRole(b, 'brand_admin')
    await setRole(v, 'viewer')
  })

  it('refuses a role change and a removal by an admin who has since been made a viewer', async () => {
    await setRole(a, 'viewer')
    const actor = { brandId: brand, actorId: a, actorIsPlatformOwner: false, targetId: b }
    const change = await refusal(changeMemberRole(stack.appPool, audit, { ...actor, role: 'viewer' }))
    expect([change.status, change.code]).toEqual([403, 'forbidden'])
    const remove = await refusal(removeMember(stack.appPool, audit, actor))
    expect([remove.status, remove.code]).toEqual([403, 'forbidden'])
    expect(await roleOf(b)).toBe('brand_admin')
  })

  it('refuses an admin who has since been removed from the brand', async () => {
    await stack.db.admin.query('delete from app.membership where brand_id = $1 and user_id = $2', [brand, a])
    try {
      const actor = { brandId: brand, actorId: a, actorIsPlatformOwner: false, targetId: b }
      const change = await refusal(changeMemberRole(stack.appPool, audit, { ...actor, role: 'viewer' }))
      expect(change.status).toBe(403)
      expect(await roleOf(b)).toBe('brand_admin')
    } finally {
      await stack.db.admin.query(
        "insert into app.membership (brand_id, user_id, role) values ($1, $2, 'brand_admin')",
        [brand, a],
      )
    }
  })

  it('checks the actor before anything else: a demoted admin learns nothing about the target', async () => {
    await setRole(a, 'viewer')
    const missing = '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b'
    const actor = { brandId: brand, actorId: a, actorIsPlatformOwner: false, targetId: missing }
    expect((await refusal(removeMember(stack.appPool, audit, actor))).status).toBe(403)
  })

  it('lets the platform owner act with no membership in the brand', async () => {
    const actor = { brandId: brand, actorId: owner, actorIsPlatformOwner: true, targetId: v }
    const result = await changeMemberRole(stack.appPool, audit, { ...actor, role: 'approver' })
    expect(result).toEqual({ userId: v, role: 'approver', changed: true })
    expect(await roleOf(v)).toBe('approver')
    await removeMember(stack.appPool, audit, actor)
    expect(await roleOf(v)).toBeUndefined()
    await stack.db.admin.query(
      "insert into app.membership (brand_id, user_id, role) values ($1, $2, 'viewer')",
      [brand, v],
    )
  })

  it('makes a second change wait for the first, and then judges it on the committed state', async () => {
    // A demotes B and is held inside its transaction, after taking the lock.
    audit.holdNext()
    const first = changeMemberRole(stack.appPool, audit, {
      brandId: brand,
      actorId: a,
      actorIsPlatformOwner: false,
      targetId: b,
      role: 'viewer',
    })
    await audit.arrived
    // Meanwhile B, whose session still says brand admin, tries to demote A.
    let settled = false
    const second = changeMemberRole(stack.appPool, audit, {
      brandId: brand,
      actorId: b,
      actorIsPlatformOwner: false,
      targetId: a,
      role: 'viewer',
    }).then(
      () => ((settled = true), null),
      (e: unknown) => ((settled = true), e),
    )
    // Wait until the database shows the second transaction blocked on a lock: then it cannot have finished.
    for (let i = 0; i < 100; i++) {
      const waiting = await stack.db.admin.query(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      )
      if (waiting.rows[0].n > 0) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const waiting = await stack.db.admin.query(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    )
    expect(waiting.rows[0].n).toBe(1)
    expect(settled).toBe(false)
    audit.release()
    expect(await first).toMatchObject({ changed: true })
    const error = await second
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(403)
    expect(await roleOf(a)).toBe('brand_admin')
    expect(await roleOf(b)).toBe('viewer')
  })
})
