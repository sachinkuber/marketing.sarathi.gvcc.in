import { z } from 'zod'
import type { RouteTable } from '../access/routes.ts'
import { rawBodyOf } from '../access/trigger-auth.ts'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'

const pingBody = z.strictObject({ workflow: z.string().min(1).max(200) })

// The body arrives as the exact bytes that were signed; it is parsed only after the signature has been proved.
function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  let json: unknown
  try {
    json = JSON.parse(rawBodyOf(raw).toString('utf8'))
  } catch {
    throw new AppError(400, 'invalid_json', 'The request body is not valid JSON.')
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new AppError(400, 'invalid_request', 'The request is not valid.')
  return parsed.data
}

export function registerTriggerRoutes(table: RouteTable, deps: { audit: AuditSink }): void {
  table.add({
    method: 'post',
    path: '/triggers/ping',
    access: { kind: 'trigger' },
    summary: 'n8n proves it can reach the service with a signed call',
    handlers: [
      async (req, res) => {
        const body = parseBody(pingBody, req.body)
        await deps.audit.record({
          action: 'trigger.received',
          actor: null,
          actorKind: 'n8n',
          brandId: null,
          subject: 'ping',
          outcome: 'success',
          detail: { workflow: body.workflow },
        })
        res.json({ ok: true })
      },
    ],
  })
}
