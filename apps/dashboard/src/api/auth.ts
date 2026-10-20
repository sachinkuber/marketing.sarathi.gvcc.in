import { z } from 'zod'
import { ApiError, authCall, setCsrfToken } from './client'
import { loadSession, type Session } from './session'

// The sign-in library's routes under /api/auth, called as apps/core/test/support.ts does.
const loose = z.looseObject({})
const signInReply = z.looseObject({ twoFactorRedirect: z.boolean().optional() })
const enableReply = z.looseObject({ totpURI: z.string(), backupCodes: z.array(z.string()) })

export type SignInResult = { kind: 'second_factor' } | { kind: 'signed_in'; session: Session }

export async function signIn(email: string, password: string): Promise<SignInResult> {
  setCsrfToken(null)
  const reply = await authCall(signInReply, 'POST', '/sign-in/email', { email, password })
  if (reply.twoFactorRedirect) return { kind: 'second_factor' }
  return { kind: 'signed_in', session: await loadSession() }
}

export async function verifyTotp(code: string): Promise<Session> {
  await authCall(loose, 'POST', '/two-factor/verify-totp', { code })
  return loadSession()
}

export async function verifyBackupCode(code: string): Promise<Session> {
  await authCall(loose, 'POST', '/two-factor/verify-backup-code', { code })
  return loadSession()
}

export async function enableTwoFactor(
  password: string,
): Promise<{ secret: string; totpUri: string; backupCodes: string[] }> {
  const reply = await authCall(enableReply, 'POST', '/two-factor/enable', { password })
  const secret = new URL(reply.totpURI).searchParams.get('secret')
  if (!secret) throw new ApiError(200, 'bad_reply', 'The platform sent a reply this page cannot read.')
  return { secret, totpUri: reply.totpURI, backupCodes: reply.backupCodes }
}

export async function requestReset(email: string): Promise<void> {
  await authCall(loose, 'POST', '/request-password-reset', { email, redirectTo: '/reset-password' })
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  await authCall(loose, 'POST', '/reset-password', { token, newPassword })
}

export async function signOut(): Promise<void> {
  await loadSession()
  await authCall(loose, 'POST', '/sign-out', {})
  setCsrfToken(null)
}

// What to tell a person when a sign-in step fails; never says which half was wrong.
export function signInMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return 'Too many attempts. The account is locked for a while; try again later.'
    if (error.status === 0) return 'The platform could not be reached. Try again.'
  }
  return 'The email or password is not right.'
}

export function codeMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429)
      return 'Too many wrong codes. Sign-in is locked for a while; the attempts are recorded.'
    if (error.status === 0) return 'The platform could not be reached. Try again.'
  }
  return 'That code is not right. Check the app and try again.'
}
