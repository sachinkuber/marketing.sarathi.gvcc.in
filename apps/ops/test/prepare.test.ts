import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseUrl, requireDatabase } from '@mkt/test-support'
import { prepare } from '../src/prepare.ts'
import { ROLES, type Role } from '../src/set-role-passwords.ts'

// The roles are global to the cluster that the whole test suite shares. The other tests give them these
// passwords (packages/db/src/testing.ts), so they are put back afterwards.
const DEV_PASSWORD = (role: Role) => `dev_only_${role.replace(/^mkt_/, '')}`

function urlWith(database: string, user?: string, pass?: string): string {
  const url = new URL(databaseUrl)
  url.pathname = `/${database}`
  if (user) {
    url.username = user
    url.password = pass ?? ''
  }
  return url.toString()
}

async function asSuperuser<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const newPasswords = (): Record<Role, string> =>
  Object.fromEntries(ROLES.map((role) => [role, randomBytes(24).toString('base64url')])) as Record<
    Role,
    string
  >

// A throw-away database with nothing in it: prepare must build it from empty, as on a new server.
const name = `mkt_t_${randomBytes(5).toString('hex')}`
const adminUrl = urlWith(name)

beforeAll(async () => {
  await requireDatabase()
  await asSuperuser((c) => c.query(`create database ${name}`))
})

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(`drop database if exists ${name} with (force)`)
    for (const role of ROLES) await c.query(`alter role ${role} password '${DEV_PASSWORD(role)}'`)
  })
})

describe('prepare', () => {
  it('prepare twice migrates once and leaves the same queues', async () => {
    const first = await prepare({ adminUrl, rolePasswords: newPasswords() })
    const second = await prepare({ adminUrl, rolePasswords: newPasswords() })

    expect(first.migrated.length).toBeGreaterThanOrEqual(21)
    expect(first.migrated).toContain('0021_worker_heartbeat')
    expect(second.migrated).toEqual([])
    expect(first.queues).toEqual([
      'dead-bulk',
      'dead-interactive',
      'dead-production',
      'dead-publishing',
      'job-bulk',
      'job-interactive',
      'job-production',
      'job-publishing',
    ])
    expect(second.queues).toEqual(first.queues)
  })

  it('after prepare each role signs in with its new password', async () => {
    const passwords = newPasswords()
    await prepare({ adminUrl, rolePasswords: passwords })
    for (const role of ROLES) {
      const client = new pg.Client({ connectionString: urlWith(name, role, passwords[role]) })
      await client.connect()
      try {
        const { rows } = await client.query<{ who: string }>('select current_user as who')
        expect(rows[0]?.who).toBe(role)
      } finally {
        await client.end()
      }
      const wrong = new pg.Client({ connectionString: urlWith(name, role, DEV_PASSWORD(role)) })
      await expect(wrong.connect()).rejects.toThrow(/password authentication failed/)
      await wrong.end().catch(() => undefined)
    }
  })

  it('prepare refuses a password containing CHANGE_ME', async () => {
    const passwords = { ...newPasswords(), mkt_queue: 'CHANGE_ME_to_a_long_random_value' }
    await expect(prepare({ adminUrl, rolePasswords: passwords })).rejects.toThrow(/mkt_queue.*CHANGE_ME/)
  })

  it('prepare refuses an empty password and names no password in its error', async () => {
    const passwords = { ...newPasswords(), mkt_app: '' }
    const error = await prepare({ adminUrl, rolePasswords: passwords }).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/mkt_app/)
    for (const value of Object.values(passwords)) {
      if (value) expect((error as Error).message).not.toContain(value)
    }
  })
})
