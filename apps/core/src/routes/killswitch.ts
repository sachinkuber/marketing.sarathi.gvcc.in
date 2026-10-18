import { withBrand, type Pool } from '@mkt/db'
import { z } from 'zod'
import { verifySecondFactorCode } from '../access/step-up.ts'
import { brandContextOf } from '../access/brand-access.ts'
import type { RouteTable } from '../access/routes.ts'
import type { Auth } from '../auth/options.ts'
import { principalOf } from '../auth/session.ts'
import { AppError } from '../errors.ts'
import { listActive, releaseSwitch, setSwitch } from '../killswitch/service.ts'
import type { AuditSink } from '../ports.ts'
import { inputOf, validate } from '../validate.ts'

export interface KillSwitchRouteDeps {
  auth: Auth
  pool: Pool
  audit: AuditSink
}

const params = z.strictObject({ brandId: z.uuid() })
const code = z.string().regex(/^\d{6}$/)
// A target is required for channel and agent scope, and absent for brand scope (the table's own check).
const body = z
  .strictObject({
    scope: z.enum(['brand', 'channel', 'agent']),
    target: z.string().trim().min(1).max(120).optional(),
    code,
  })
  .refine((b) => (b.scope === 'brand') === (b.target === undefined), {
    message: 'a target is needed for channel and agent scope, and not for brand scope',
    path: ['target'],
  })
const shadowBody = z.strictObject({ shadow_mode: z.boolean() })

export function registerKillSwitchRoutes(table: RouteTable, deps: KillSwitchRouteDeps): void {
  table.add({
    method: 'get',
    path: '/brands/:brandId/kill-switch',
    access: { kind: 'permission', permission: 'use_kill_switch' },
    summary: 'The active kill switches of a brand, and its shadow flag',
    handlers: [
      validate({ params }),
      async (_req, res) => {
        const brandId = brandContextOf(res).brandId
        const switches = await listActive(deps.pool, brandId)
        const shadow = await withBrand(deps.pool, brandId, (client) =>
          client.query<{ shadow_mode: boolean }>('select shadow_mode from app.brand where id = $1', [
            brandId,
          ]),
        )
        res.json({ switches, shadowMode: shadow.rows[0]?.shadow_mode ?? false })
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/kill-switch',
    access: { kind: 'permission', permission: 'use_kill_switch' },
    summary: 'Set a kill switch (brand, channel or agent); holds waiting jobs; asks for the actor’s own code',
    handlers: [
      validate({ params, body }),
      async (req, res) => {
        const { body: b } = inputOf<{ body: z.infer<typeof body> }>(res)
        await verifySecondFactorCode(deps.auth, req, b.code)
        const result = await setSwitch(
          deps.pool,
          { audit: deps.audit },
          {
            brandId: brandContextOf(res).brandId,
            scope: b.scope,
            target: b.target ?? null,
            actor: principalOf(res).userId,
          },
        )
        res.json(result)
      },
    ],
  })

  table.add({
    method: 'post',
    path: '/brands/:brandId/kill-switch/release',
    access: { kind: 'permission', permission: 'use_kill_switch' },
    summary: 'Release a kill switch; asks for the actor’s own code',
    handlers: [
      validate({ params, body }),
      async (req, res) => {
        const { body: b } = inputOf<{ body: z.infer<typeof body> }>(res)
        await verifySecondFactorCode(deps.auth, req, b.code)
        const result = await releaseSwitch(
          deps.pool,
          { audit: deps.audit },
          {
            brandId: brandContextOf(res).brandId,
            scope: b.scope,
            target: b.target ?? null,
            actor: principalOf(res).userId,
          },
        )
        res.json({ released: result.released, unheld: result.unheldJobIds.length })
      },
    ],
  })

  // Ruling: the route table puts a :brandId route under member or permission, so this carries the kill-switch
  // permission and then insists, in the handler, on a platform owner. A brand admin has the permission and
  // still gets 403. In phase 1 the flag is stored and shown only; no second factor is asked.
  table.add({
    method: 'patch',
    path: '/brands/:brandId/shadow-mode',
    access: { kind: 'permission', permission: 'use_kill_switch' },
    summary: 'Turn a brand’s shadow mode on or off (platform owner only)',
    handlers: [
      validate({ params, body: shadowBody }),
      async (_req, res) => {
        const actor = principalOf(res)
        if (!actor.isPlatformOwner) {
          throw new AppError(403, 'forbidden', 'You do not have permission to do this.')
        }
        const { body: b } = inputOf<{ body: z.infer<typeof shadowBody> }>(res)
        const brandId = brandContextOf(res).brandId
        const shadowMode = await withBrand(deps.pool, brandId, async (client) => {
          const before = await client.query<{ shadow_mode: boolean }>(
            'select shadow_mode from app.brand where id = $1 for update',
            [brandId],
          )
          if (!before.rows[0]) throw new AppError(404, 'not_found', 'There is nothing at this address.')
          await client.query('update app.brand set shadow_mode = $2 where id = $1', [brandId, b.shadow_mode])
          await deps.audit.record(
            {
              action: 'brand.shadow_mode_changed',
              actor: actor.userId,
              subject: brandId,
              brandId,
              outcome: 'success',
              detail: { from: before.rows[0].shadow_mode, to: b.shadow_mode },
            },
            client,
          )
          return b.shadow_mode
        })
        res.json({ shadowMode })
      },
    ],
  })
}
