import { z } from 'zod'
import type { RouteTable } from '../access/routes.ts'
import { rawBodyOf } from '../access/trigger-auth.ts'
import { AppError } from '../errors.ts'
import type { AuditSink } from '../ports.ts'
import type { Duty, DutyOutcome } from '../triggers/duties.ts'

const dailyBody = z.strictObject({ workflow: z.literal('marketing-daily-heartbeat') })
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

export interface DailyTrigger {
  run(today: string): Promise<Record<Duty, DutyOutcome>>
  now(): Date
}

export function registerTriggerRoutes(
  table: RouteTable,
  deps: { audit: AuditSink; daily?: DailyTrigger },
): void {
  const { daily } = deps
  if (daily) {
    table.add({
      method: 'post',
      path: '/triggers/daily',
      access: { kind: 'trigger' },
      summary: 'n8n runs the daily duties: heartbeat, audit export and verify, exchange rate, nonce clean-up',
      handlers: [
        async (req, res) => {
          parseBody(dailyBody, req.body)
          const today = daily.now().toISOString().slice(0, 10)
          const duties = await daily.run(today)
          const failed = Object.values(duties).includes('failed')
          await deps.audit.record({
            action: 'trigger.received',
            actor: null,
            actorKind: 'n8n',
            brandId: null,
            subject: 'daily',
            outcome: failed ? 'failure' : 'success',
            detail: { workflow: 'marketing-daily-heartbeat', duties },
          })
          // 502 with the same body, so n8n retries; the retry runs only the duty that failed.
          res.status(failed ? 502 : 200).json({ duties })
        },
      ],
    })
  }
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
