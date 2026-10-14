import { createHash, timingSafeEqual } from 'node:crypto'
import type { RequestHandler, Response } from 'express'
import { AppError } from '../errors.ts'
import { verifyAttemptToken, type AttemptClaims } from '../jobs/token.ts'
import type { JobsDeps } from '../jobs/service.ts'

// Compared as hashes so the lengths always match and nothing about the secret's length leaks.
const digest = (value: string) => createHash('sha256').update(value).digest()

export function workerAuth(secret: string): RequestHandler {
  const expected = digest(secret)
  return (req, _res, next) => {
    const header = req.headers.authorization
    const given =
      typeof header === 'string' && header.startsWith('Worker ') ? header.slice('Worker '.length) : ''
    if (given === '' || !timingSafeEqual(expected, digest(given))) {
      throw new AppError(401, 'unauthorized', 'A worker credential is required.')
    }
    next()
  }
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLAIMS = 'attemptClaims'
export const claimsOf = (res: Response): AttemptClaims => res.locals[CLAIMS] as AttemptClaims

// Checks the token's signature and times, and that it belongs to the job in the path. Whether the attempt is
// still the current one is the service's check, made inside the transaction that acts on it.
export function attemptAuth(deps: JobsDeps): RequestHandler {
  return async (req, res, next) => {
    const rawJobId = String(req.params.jobId ?? '')
    // The path is untrusted: record it only when it has the shape of an id, and never at any length.
    const jobId = UUID_SHAPE.test(rawJobId) ? rawJobId : rawJobId.slice(0, 64)
    const token = req.headers['x-attempt-token']
    const refuse = async (reason: string, brandId: string | null): Promise<never> => {
      await deps.audit.record({
        action: 'worker.attempt_refused',
        actor: null,
        brandId,
        subject: jobId || null,
        outcome: 'failure',
        detail: { reason, jobId },
      })
      throw new AppError(403, 'attempt_refused', 'This attempt may not do that.')
    }
    if (typeof token !== 'string' || token === '') return refuse('no_token', null)
    const checked = verifyAttemptToken(
      deps.attemptTokenSecret,
      token,
      Math.floor(deps.now().getTime() / 1000),
    )
    if (!checked.ok) return refuse(checked.reason, null)
    if (checked.claims.jobId !== rawJobId) return refuse('wrong_job', checked.claims.brandId)
    res.locals[CLAIMS] = checked.claims
    next()
  }
}
