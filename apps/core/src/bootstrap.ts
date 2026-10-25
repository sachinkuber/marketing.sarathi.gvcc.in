import { randomBytes } from 'node:crypto'
import { createPool, type Pool } from '@mkt/db'
import { z } from 'zod'
import { AttemptLimiter } from './auth/limiter.ts'
import { createAuth } from './auth/options.ts'
import { LOCK_DURATION_MS, LOCK_MAX_FAILURES, LOCK_WINDOW_MS } from './auth/policy.ts'
import { createUserWithPassword, removeAfterFailure } from './auth/users.ts'
import { DbAudit } from './audit/db-audit.ts'
import { errorName } from './notify/ports.ts'

// Owner bootstrap (plan decision 11): the first account on a new installation. Run once by the operator on
// the server, with a database role that may write the tenancy tables (the superuser, or the role that owns
// them); the running service never has that right. Running it again changes nothing.
//
//   BOOTSTRAP_DATABASE_URL=postgres://... npm run bootstrap --workspace @mkt/core -- --owner-email <address>
//
// The temporary password goes to `print` once and is not logged, audited or stored anywhere but as the
// library's hash. The owner sets up the second factor at the first sign-in (the enrolment gate).

const BRANDS = [
  { name: 'Aztek Global', slug: 'aztek-global' },
  { name: 'Test brand', slug: 'test-brand' },
] as const

const emailSchema = z.email()

export interface BootstrapOptions {
  adminUrl: string
  ownerEmail: string
  // Receives the temporary password, once, and only when an account was created.
  print: (password: string) => void
}

export async function bootstrap(options: BootstrapOptions): Promise<{ created: boolean }> {
  const parsed = emailSchema.safeParse(options.ownerEmail.trim())
  if (!parsed.success) throw new Error('The owner email is not a valid address.')
  const email = parsed.data.toLowerCase()

  const pool = createPool(options.adminUrl, { max: 2 })
  const authPool = createPool(options.adminUrl, { searchPath: 'auth', max: 2 })
  try {
    // The brands first and on their own: each is created only when its slug is free.
    for (const brand of BRANDS) {
      await pool.query(
        `select app.create_brand($1, $2) where not exists (select 1 from app.brand where slug = $2)`,
        [brand.name, brand.slug],
      )
    }
    // Done only when the user is also a platform owner; a user without owner rights is not the owner.
    const existing = await pool.query<{ owner: boolean }>(
      `select exists (select 1 from app.platform_owner o where o.user_id = u.id) as owner
         from auth."user" u where u.email = $1`,
      [email],
    )
    if (existing.rows[0]?.owner) return { created: false }
    if (existing.rowCount) {
      throw new Error(
        'A user with this address exists without owner rights. Nothing was changed; remove the user or grant the rights by hand.',
      )
    }

    // The library hashes the password itself. Nothing here sends mail, signs a session or counts attempts,
    // so the secret is a throw-away and the mailer refuses.
    const auth = createAuth({
      pool: authPool,
      secret: randomBytes(32).toString('base64url'),
      baseURL: 'http://localhost',
      mailer: {
        send: async () => {
          throw new Error('bootstrap sends no mail')
        },
      },
      audit: { record: async () => undefined },
      limiter: new AttemptLimiter({
        maxFailures: LOCK_MAX_FAILURES,
        windowMs: LOCK_WINDOW_MS,
        lockMs: LOCK_DURATION_MS,
      }),
      logger: { disabled: true },
    })
    // 18 random bytes are 24 characters of base64url: above the policy minimum and never shown twice.
    const password = randomBytes(18).toString('base64url')
    const { id } = await createUserWithPassword(auth, {
      email,
      name: email.split('@')[0] ?? 'owner',
      password,
    })
    try {
      await grantOwner(pool, id)
    } catch (error) {
      // An account with no owner rights would block a second run; take it back out.
      await removeAfterFailure(auth, id, error, 'bootstrap: user {id} left behind after a failed grant')
      throw error
    }
    options.print(password)
    return { created: true }
  } finally {
    await pool.end()
    await authPool.end()
  }
}

// The owner row, the admin membership in each brand and the audit entry, together or not at all.
async function grantOwner(pool: Pool, userId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('insert into app.platform_owner (user_id) values ($1)', [userId])
    await client.query(
      `insert into app.membership (brand_id, user_id, role, created_by)
       select id, $1, 'brand_admin', $1 from app.brand where slug = any($2)
       on conflict (brand_id, user_id) do nothing`,
      [userId, BRANDS.map((brand) => brand.slug)],
    )
    await new DbAudit(pool).record(
      {
        action: 'platform.bootstrapped',
        actor: userId,
        subject: userId,
        outcome: 'success',
        detail: { brands: BRANDS.map((brand) => brand.slug) },
      },
      client,
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

// `--owner-email <address>` or `--owner-email=<address>`; OWNER_EMAIL when the flag is absent.
export function parseArguments(
  args: string[],
  env: Record<string, string | undefined>,
): { ownerEmail: string } {
  let ownerEmail: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '--owner-email') {
      ownerEmail = args[(i += 1)]
    } else if (arg.startsWith('--owner-email=')) {
      ownerEmail = arg.slice('--owner-email='.length)
    } else {
      throw new Error('Unknown argument. Usage: --owner-email <address>')
    }
  }
  ownerEmail ||= env.OWNER_EMAIL
  if (!ownerEmail) throw new Error('Missing --owner-email <address> (or OWNER_EMAIL).')
  return { ownerEmail }
}

// Our own messages name a variable, an argument or a leftover user id, never a secret or a value.
export const isKnownMessage = (message: string): boolean =>
  /^(Missing|Unknown|The owner email|A user with this address|bootstrap:)/.test(message)

if (import.meta.main) {
  try {
    const { ownerEmail } = parseArguments(process.argv.slice(2), process.env)
    const adminUrl = process.env.BOOTSTRAP_DATABASE_URL
    if (!adminUrl) throw new Error('Missing BOOTSTRAP_DATABASE_URL.')
    const { created } = await bootstrap({
      adminUrl,
      ownerEmail,
      print: (password) => {
        process.stdout.write(
          `Temporary password for the platform owner (shown once, not stored anywhere):\n${password}\n` +
            'Sign in with it, then set up the authenticator app when asked.\n',
        )
      },
    })
    if (!created) process.stdout.write('The platform owner already exists. Nothing was changed.\n')
  } catch (error) {
    // The message of our own errors names a variable or an argument, never a value; anything else is
    // reported by name only.
    const known = error instanceof Error && isKnownMessage(error.message)
    process.stderr.write(`Bootstrap failed: ${known ? (error as Error).message : errorName(error)}\n`)
    process.exitCode = 1
  }
}
