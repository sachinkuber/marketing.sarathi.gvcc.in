import type { Pool } from '@mkt/db'
import { createHash } from 'node:crypto'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { twoFactor } from 'better-auth/plugins'
import type { AuditSink, MailMessage, Mailer } from '../ports.ts'
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
  // Production passes libraryLogger (the service logger); tests pass { disabled: true }. Unset, the library
  // writes to the console, outside the redacting logger.
  logger?: BetterAuthOptions['logger']
  // Told when a notification could not be sent. Gets only the error, never the message or the address.
  onMailFailure?: (error: unknown) => void
}

// Mail fails open: a notification that cannot be sent is reported and never changes the answer, so a
// known and an unknown address still look the same, and a used backup code still signs the person in.
// The audit sink is the opposite (fail-closed): its calls below are left unguarded on purpose, so an
// attempt that cannot be recorded is refused.
async function safeSend(deps: AuthDeps, message: MailMessage): Promise<void> {
  try {
    await deps.mailer.send(message)
  } catch (error) {
    deps.onMailFailure?.(error)
  }
}

const AUDITED: Record<string, string> = {
  '/sign-in/email': 'auth.sign_in',
  '/two-factor/verify-totp': 'auth.second_factor',
  '/two-factor/verify-backup-code': 'auth.backup_code_used',
  '/request-password-reset': 'auth.password_reset_requested',
  '/reset-password': 'auth.password_reset',
}

function bodyEmail(body: unknown): string | null {
  const email = (body as { email?: unknown } | undefined)?.email
  return typeof email === 'string' ? email : null
}

export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16)
}

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

const SECOND_FACTOR_PATHS = ['/two-factor/verify-totp', '/two-factor/verify-backup-code']
const EMAIL_CODE_PATHS = ['/two-factor/send-otp', '/two-factor/verify-otp']
const TWO_FACTOR_COOKIE = 'two_factor'

// The account a second-factor guess is aimed at: the user in the session (enrolment) or the user the
// pending sign-in belongs to (the signed cookie the library set after the password step names a
// verification record whose value is the user id). Nothing the caller controls, such as extra cookies,
// changes it, and a new sign-in does not start a new count.
async function secondFactorUserId(ctx: HookContext): Promise<string | null> {
  const session = await getSessionFromCtx(ctx).catch(() => null)
  if (session?.user.id) return session.user.id
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE)
  const signed = await ctx.getSignedCookie(cookie.name, ctx.context.secret)
  if (!signed) return null
  const pending = await ctx.context.internalAdapter.findVerificationValue(signed)
  return pending?.value ?? null
}

// What a lockout is counted against. Sign-in and recovery: the address. A second-factor guess: the
// account, shared by the code and backup-code routes.
async function limitedKey(ctx: HookContext): Promise<string | null> {
  const email = (ctx.body as { email?: unknown } | undefined)?.email
  if (
    (ctx.path === '/sign-in/email' || ctx.path === '/request-password-reset') &&
    typeof email === 'string'
  ) {
    return attemptKey(ctx.path, email)
  }
  if (SECOND_FACTOR_PATHS.includes(ctx.path)) {
    const userId = await secondFactorUserId(ctx)
    return userId ? attemptKey('/two-factor', userId) : null
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
    // An error that is not the library's own (a database or audit failure) is passed on to the service's
    // error handler, which logs it and answers 500. Without this the library's router prints it with
    // console.error, outside the redacting logger.
    onAPIError: { throw: true },
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
        await safeSend(deps, {
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
        // Spec 7: the second factor is the authenticator app. The emailed one-time code is refused here,
        // not only by leaving otpOptions unset, so a later configuration change cannot make it one.
        if (EMAIL_CODE_PATHS.includes(ctx.path)) {
          throw new APIError('FORBIDDEN', { message: 'Use the code from your authenticator app.' })
        }
        // SEC-1 and spec 7: every sign-in asks for the second factor. With trustDevice the library would
        // set a signed trust_device cookie and skip the second factor from that browser for 30 days.
        // That flag on these routes is the only thing in the library that creates the cookie.
        if (
          SECOND_FACTOR_PATHS.includes(ctx.path) &&
          (ctx.body as { trustDevice?: unknown } | undefined)?.trustDevice
        ) {
          throw new APIError('FORBIDDEN', {
            message: 'A device cannot be remembered; the second factor is asked every time.',
          })
        }
        const key = await limitedKey(ctx)
        if (key && deps.limiter.check(key) > 0) {
          const email = bodyEmail(ctx.body)
          await deps.audit.record({
            action: 'auth.locked_out',
            actor: null,
            outcome: 'failure',
            detail: { path: ctx.path, ...(email ? { emailHash: emailHash(email) } : {}) },
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
        let key = await limitedKey(ctx)
        // A finished second-factor step has used up the pending challenge, so the account comes from the new session.
        if (!key && !failed && user && SECOND_FACTOR_PATHS.includes(ctx.path))
          key = attemptKey('/two-factor', user.id)
        if (key) {
          // A reset request always answers the same, so it is counted whatever the outcome: that is what
          // stops someone filling a person's inbox with reset mail.
          if (failed || ctx.path === '/request-password-reset') deps.limiter.fail(key)
          // Only a finished second-factor step clears the account's count; a correct password never does.
          else deps.limiter.succeed(key)
        }
        const email = bodyEmail(ctx.body)
        await deps.audit.record({
          action,
          actor: user?.id ?? null,
          outcome: failed ? 'failure' : 'success',
          ...(email ? { detail: { emailHash: emailHash(email) } } : {}),
        })
        if (ctx.path === '/two-factor/verify-backup-code' && !failed && user) {
          await safeSend(deps, {
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
