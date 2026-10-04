import type { Pool } from '@mkt/db'
import { Router } from 'express'
import { z } from 'zod'
import { acceptInvite, lookupInvite } from '../auth/invites.ts'
import type { Auth } from '../auth/options.ts'
import { PASSWORD_MAX, PASSWORD_MIN } from '../auth/policy.ts'
import { inputOf, validate } from '../validate.ts'

const token = z.string().min(20).max(200)
const lookupBody = z.strictObject({ token })
const acceptBody = z.strictObject({
  token,
  name: z.string().trim().min(1).max(100),
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
})

// Public: the person has no session yet. The origin check in the request guard still applies.
export function inviteRoutes(deps: { auth: Auth; pool: Pool }): Router {
  const router = Router()
  router.post('/lookup', validate({ body: lookupBody }), async (_req, res) => {
    const { body } = inputOf<{ body: z.infer<typeof lookupBody> }>(res)
    res.json(await lookupInvite(deps.pool, body.token))
  })
  router.post('/accept', validate({ body: acceptBody }), async (_req, res) => {
    const { body } = inputOf<{ body: z.infer<typeof acceptBody> }>(res)
    const accepted = await acceptInvite(deps.auth, deps.pool, body)
    res.status(201).json({ userId: accepted.userId })
  })
  return router
}
