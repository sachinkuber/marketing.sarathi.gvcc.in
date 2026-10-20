import type { Pool } from '@mkt/db'
import type { RequestHandler } from 'express'
import type { Logger } from 'pino'
import { AppError } from '../errors.ts'
import { useNonce } from '../triggers/nonce.ts'
import { NONCE_HEADER, checkSignature, type TriggerRefusal } from '../triggers/signature.ts'

export interface TriggerDeps {
  secret: string
  pool: Pool
  now: () => Date
  logger: Pick<Logger, 'warn'>
}

// The raw body is the Buffer the parser mounted for /triggers left in req.body (see app.ts).
export const rawBodyOf = (body: unknown): Buffer => (Buffer.isBuffer(body) ? body : Buffer.alloc(0))

// A signed call from n8n. A refusal is logged with its reason only (no header, body, secret or signature) and
// answered the same way every time; it is not audited, so a stranger cannot grow the audit log.
export function triggerAuth(deps: TriggerDeps): RequestHandler {
  const refuse = (reason: TriggerRefusal): never => {
    deps.logger.warn({ event: 'trigger_refused', reason })
    throw new AppError(401, 'trigger_refused', 'This trigger was refused.')
  }
  return async (req, _res, next) => {
    const checked = checkSignature({
      secret: deps.secret,
      method: req.method,
      originalUrl: req.originalUrl,
      headers: req.headers,
      rawBody: rawBodyOf(req.body),
      nowSeconds: Math.floor(deps.now().getTime() / 1000),
    })
    if (!checked.ok) return refuse(checked.reason)
    // Only a request that proved the secret reaches the nonce table.
    if (!(await useNonce(deps.pool, req.headers[NONCE_HEADER] as string))) return refuse('replayed')
    next()
  }
}
