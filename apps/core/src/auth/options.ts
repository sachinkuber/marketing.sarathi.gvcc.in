import type { Pool } from '@mkt/db'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { twoFactor } from 'better-auth/plugins'
import type { AuditSink, Mailer } from '../ports.ts'
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
}

export function authOptions(deps: AuthDeps): BetterAuthOptions {
  return {
    appName: 'Marketing platform',
    baseURL: deps.baseURL,
    basePath: '/api/auth',
    secret: deps.secret,
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
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/two-factor/verify-backup-code') return
        const returned = ctx.context.returned
        const failed = returned instanceof APIError
        const user = ctx.context.newSession?.user
        await deps.audit.record({
          action: 'auth.backup_code_used',
          actor: user?.id ?? null,
          outcome: failed ? 'failure' : 'success',
        })
        if (!failed && user) {
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
