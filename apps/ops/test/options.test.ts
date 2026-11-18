import { describe, expect, it } from 'vitest'
import { optionsFromEnv } from '../src/prepare.ts'

const PASSWORDS = {
  MKT_APP_PASSWORD: 'app-pw-1',
  MKT_AUDIT_WRITER_PASSWORD: 'audit-pw-1',
  MKT_QUEUE_PASSWORD: 'queue-pw-1',
  MKT_OWNER_VIEW_PASSWORD: 'owner-pw-1',
}

describe('optionsFromEnv', () => {
  it('reads the admin address and the four role passwords', () => {
    const adminUrl = 'postgres://postgres:s3cret-value@postgres:5432/mkt'
    expect(optionsFromEnv({ ADMIN_DATABASE_URL: adminUrl, ...PASSWORDS })).toEqual({
      adminUrl,
      rolePasswords: {
        mkt_app: 'app-pw-1',
        mkt_audit_writer: 'audit-pw-1',
        mkt_queue: 'queue-pw-1',
        mkt_owner_view: 'owner-pw-1',
      },
    })
  })

  it('names a missing variable', () => {
    expect(() => optionsFromEnv({ ...PASSWORDS })).toThrow(/ADMIN_DATABASE_URL/)
  })

  it('refuses an ADMIN_DATABASE_URL still holding CHANGE_ME, naming the variable and never the value', () => {
    const adminUrl = 'postgres://postgres:CHANGE_ME_secretish@postgres:5432/mkt'
    let message = ''
    try {
      optionsFromEnv({ ADMIN_DATABASE_URL: adminUrl, ...PASSWORDS })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/ADMIN_DATABASE_URL.*CHANGE_ME/)
    expect(message).not.toContain('secretish')
    expect(message).not.toContain('postgres://')
  })
})
