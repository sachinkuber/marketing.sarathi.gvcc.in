import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import pg from 'pg'

// The run-time roles that sign in. The migrations create them without a login (0001); deployment gives each
// one its own secret from roles.env (plan decision 5). mkt_readonly and mkt_definer never sign in.
export const ROLES = ['mkt_app', 'mkt_audit_writer', 'mkt_queue', 'mkt_owner_view'] as const
export type Role = (typeof ROLES)[number]
export type RolePasswords = Record<Role, string>

// Printable ASCII without spaces: every client (node-pg, libpq) then derives the same SCRAM key, because
// SASLprep changes nothing in that range.
const PRINTABLE = /^[\x21-\x7e]+$/

// Refuses before anything is changed. Names the role, never the value.
export function checkRolePasswords(passwords: RolePasswords): void {
  const problems: string[] = []
  for (const role of ROLES) {
    const value = passwords[role]
    if (typeof value !== 'string' || value === '') problems.push(`${role} is empty`)
    else if (value.includes('CHANGE_ME')) problems.push(`${role} still contains CHANGE_ME`)
    else if (!PRINTABLE.test(value)) problems.push(`${role} must be printable ASCII with no spaces`)
  }
  if (problems.length > 0) throw new Error(`Refusing to set the role passwords: ${problems.join('; ')}.`)
}

// The SCRAM-SHA-256 verifier Postgres would store for this password (RFC 5802, RFC 7677). Sending the
// verifier instead of the password keeps the password out of the server's statement and error logs.
export function scramVerifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  const keys = `${storedKey.toString('base64')}:${serverKey.toString('base64')}`
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${keys}`
}

// Gives each run-time role a login and its password. Run as the database superuser, at deployment only.
export async function setRolePasswords(adminUrl: string, passwords: RolePasswords): Promise<void> {
  checkRolePasswords(passwords)
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    for (const role of ROLES) {
      const verifier = client.escapeLiteral(scramVerifier(passwords[role]))
      await client.query(`alter role ${role} with login password ${verifier}`)
    }
  } finally {
    await client.end()
  }
}
