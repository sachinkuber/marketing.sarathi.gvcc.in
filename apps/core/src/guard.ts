import type { Request, RequestHandler } from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from './errors.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// The token is derived from the session, so it needs no storage and changes with every session.
export function csrfTokenFor(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('hex')
}

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export interface GuardOptions {
  allowedOrigins: string[]
  secret: string
  sessionIdFor: (req: Request) => Promise<string | null>
}

export function requestGuard(options: GuardOptions): RequestHandler {
  const allowed = new Set(options.allowedOrigins)
  return async (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next()
      return
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new AppError(403, 'cross_site_request', 'This request was sent from another site.')
    }
    const origin = req.headers.origin
    if (typeof origin !== 'string' || !allowed.has(origin)) {
      throw new AppError(403, 'bad_origin', 'This request did not come from this application.')
    }
    const sessionId = await options.sessionIdFor(req)
    if (sessionId) {
      const sent = req.headers['x-csrf-token']
      if (typeof sent !== 'string' || !sameValue(sent, csrfTokenFor(options.secret, sessionId))) {
        throw new AppError(403, 'bad_csrf_token', 'The request token is missing or wrong.')
      }
    }
    next()
  }
}
