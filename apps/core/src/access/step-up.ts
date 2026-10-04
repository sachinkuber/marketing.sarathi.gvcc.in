import { APIError } from 'better-auth/api'
import { fromNodeHeaders } from 'better-auth/node'
import type { Request } from 'express'
import type { Auth } from '../auth/options.ts'
import { AppError } from '../errors.ts'

// authOptions() is typed as the library's general options, so the plugin's endpoint is not in the type of
// `Auth`. The endpoint exists at runtime (the two-factor plugin is always configured); this names the one
// call used here.
type VerifyTotp = (input: { body: { code: string }; headers: Headers }) => Promise<unknown>

// "The second factor is asked again before changing roles, using the kill switch or exporting data."
// The code is the signed-in person's own current authenticator code, checked by the sign-in library's own
// TOTP check. That check runs the same hooks as a sign-in: the per-account lockout and the audit entry apply
// here too, so a stolen session cannot be used to guess codes without limit.
export async function verifySecondFactorCode(auth: Auth, req: Request, code: string): Promise<void> {
  try {
    const api = auth.api as unknown as { verifyTOTP: VerifyTotp }
    await api.verifyTOTP({ body: { code }, headers: fromNodeHeaders(req.headers) })
  } catch (error) {
    if (error instanceof APIError) {
      if (error.statusCode === 429) {
        throw new AppError(429, 'too_many_attempts', 'Too many attempts. Try again later.')
      }
      // Only the library's refusals mean the code is wrong. Its own failures (5xx) pass on as errors.
      if (error.statusCode < 500) {
        throw new AppError(403, 'second_factor_invalid', 'The code is not right.')
      }
    }
    throw error
  }
}
