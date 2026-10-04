import type { Pool } from '@mkt/db'
import { createHash } from 'node:crypto'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { twoFactor } from 'better-auth/plugins'
import type { AuditSink, Mailer } from '../ports.ts'
import { attemptKey, type AttemptLimiter } from './limiter.ts'
import {
  BACKUP_CODE_COUNT,
  BACKUP_CODE_LENGTH,
  PASSWORD_MAX,
  PASSWORD_MIN,
  RESET_LINK_SECONDS,
  SESSION_IDLE_SECONDS,
  SESSION_REFRESH_SECONDS,
} from './policy.ts'

export interface AuthDeps {
  pool: Pool
  secret: string
  baseURL: string
  mailer: Mailer
  audit: AuditSink
  limiter: AttemptLimiter
  // Left unset in production; tests pass { disabled: true } to keep the library's warnings out of the output.
  logger?: BetterAuthOptions['logger']
}

const AUDITED: Record<string, string> = {
  '/sign-in/email': 'auth.sign_in',
  '/two-factor/verify-totp': 'auth.second_factor',
  '/two-factor/verify-backup-code': 'auth.backup_code_used',
  '/request-password-reset': 'auth.password_reset_requested',
  '/reset-password': 'auth.password_reset',
}

export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16)
}

// What a lockout is counted against. Sign-in and recovery: the address. A second-factor guess: the
// pending sign-in it belongs to, which is named by the cookie the library set after the password step.
function limitedKey(path: string, body: unknown, headers: Headers | undefined): string | null {
  const email = (body as { email?: unknown } | undefined)?.email
  if ((path === '/sign-in/email' || path === '/request-password-reset') && typeof email === 'string') {
    return attemptKey(path, email)
  }
  if (path === '/two-factor/verify-totp' || path === '/two-factor/verify-backup-code') {
    const cookie = headers?.get('cookie')
    return cookie ? attemptKey(path, createHash('sha256').update(cookie).digest('hex')) : null
  }
  return null
}

export function authOptions(deps: AuthDeps): BetterAuthOptions {
  return {
    appName: 'Marketing platform',
    baseURL: deps.baseURL,
    basePath: '/api/auth',
    secret: deps.secret,
    logger: deps.logger,
    trustedOrigins: [deps.baseURL],
    database: deps.pool,
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: deps.baseURL.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      resetPasswordTokenExpiresIn: RESET_LINK_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        await deps.mailer.send({
          to: user.email,
          subject: 'Reset your password',
          text: `Open this link to choose a new password:\n${deps.baseURL}/reset-password?token=${token}\nThe link works once and expires in 30 minutes. You will still be asked for your second factor when you sign in.`,
        })
      },
    },
    session: { expiresIn: SESSION_IDLE_SECONDS, updateAge: SESSION_REFRESH_SECONDS },
    plugins: [
      twoFactor({
        issuer: 'Marketing platform',
        skipVerificationOnEnable: false,
        backupCodeOptions: { amount: BACKUP_CODE_COUNT, length: BACKUP_CODE_LENGTH },
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // SEC-1: there is no way to turn the second factor off. A lost one is reset by the platform owner.
        if (ctx.path === '/two-factor/disable') {
          throw new APIError('FORBIDDEN', { message: 'The second factor cannot be turned off.' })
        }
        const key = limitedKey(ctx.path, ctx.body, ctx.headers)
        if (key && deps.limiter.check(key) > 0) {
          await deps.audit.record({
            action: 'auth.locked_out',
            actor: null,
            outcome: 'failure',
            detail: { path: ctx.path },
          })
          throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many attempts. Try again later.' })
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const action = AUDITED[ctx.path]
        if (!action) return
        const returned = ctx.context.returned
        const failed = returned instanceof APIError
        const user = ctx.context.newSession?.user ?? ctx.context.session?.user
        const key = limitedKey(ctx.path, ctx.body, ctx.headers)
        if (key) {
          if (failed) deps.limiter.fail(key)
          else deps.limiter.succeed(key)
        }
        const email =
          typeof (ctx.body as { email?: unknown } | undefined)?.email === 'string'
            ? (ctx.body as { email: string }).email
            : null
        await deps.audit.record({
          action,
          actor: user?.id ?? null,
          outcome: failed ? 'failure' : 'success',
          ...(email ? { detail: { emailHash: emailHash(email) } } : {}),
        })
        if (ctx.path === '/two-factor/verify-backup-code' && !failed && user) {
          await deps.mailer.send({
            to: user.email,
            subject: 'A backup code was used to sign in',
            text: 'A backup code was just used to sign in to your account. If this was not you, contact the platform owner.',
          })
        }
      }),
    },
  }
}

export function createAuth(deps: AuthDeps) {
  return betterAuth(authOptions(deps))
}

export type Auth = ReturnType<typeof createAuth>
