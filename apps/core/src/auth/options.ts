import type { Pool } from '@mkt/db'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { twoFactor } from 'better-auth/plugins'
import type { AuditSink, Mailer } from '../ports.ts'
import {
  BACKUP_CODE_COUNT,
  BACKUP_CODE_LENGTH,
  PASSWORD_MAX,
  PASSWORD_MIN,
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
    },
    session: { expiresIn: SESSION_IDLE_SECONDS, updateAge: SESSION_REFRESH_SECONDS },
    plugins: [
      twoFactor({
        issuer: 'Marketing platform',
        skipVerificationOnEnable: false,
        backupCodeOptions: { amount: BACKUP_CODE_COUNT, length: BACKUP_CODE_LENGTH },
      }),
    ],
  }
}

export function createAuth(deps: AuthDeps) {
  return betterAuth(authOptions(deps))
}

export type Auth = ReturnType<typeof createAuth>
