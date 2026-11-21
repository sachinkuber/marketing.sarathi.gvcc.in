import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase } from '@mkt/test-support'
import { createTestDatabase, type TestDatabase } from '@mkt/db/testing'

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url))

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [MAIN, 'cases', ...args], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

let db: TestDatabase
let brandA: string
let owner: string
beforeAll(async () => {
  await requireDatabase()
  db = await createTestDatabase()
  const u = await db.admin.query<{ id: string }>(
    `insert into auth."user" (name, email, "emailVerified") values ('o', 'o@cases.test', true) returning id`,
  )
  owner = u.rows[0]!.id
  const a = await db.admin.query<{ create_brand: string }>(
    `select app.create_brand('Brand A', 'brand-a') as create_brand`,
  )
  brandA = a.rows[0]!.create_brand
  await db.admin.query(`select app.create_brand('Brand B', 'brand-b')`)
}, 120_000)
afterAll(async () => db?.drop())

describe('ops cases', () => {
  it('lists candidates as JSON lines, oldest first, and writes nothing', async () => {
    const add = (agent: string, brand: string, body: object) =>
      db.admin.query(`select app.add_evaluation_case($1, $2, $3::jsonb, $4)`, [
        agent,
        brand,
        JSON.stringify(body),
        owner,
      ])
    const brandB = (await db.admin.query<{ id: string }>(`select id from app.brand where slug = 'brand-b'`))
      .rows[0]!.id
    await add('research_merge', brandA, { n: 1 })
    await add('research_merge', brandB, { n: 2 })
    await add('research_merge', brandA, { n: 3 })
    await add('strategist', brandA, { n: 4 })
    const dropped = await add('research_merge', brandA, { n: 5 })
    await db.admin.query(`update app.evaluation_case set status = 'dropped' where id = $1`, [
      dropped.rows[0].add_evaluation_case,
    ])
    const before = (await db.admin.query('select count(*)::int as n from app.evaluation_case')).rows[0].n

    const env = { ADMIN_DATABASE_URL: db.urlFor('migration') }
    const all = run(['--agent', 'research_merge'], env)
    expect(all.code).toBe(0)
    const lines = all.out
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as {
            id: string
            agent: string
            brand: string
            createdAt: string
            body: { n: number }
          },
      )
    expect(lines.map((l) => l.body.n)).toEqual([1, 2, 3])
    expect(lines[0]).toMatchObject({ agent: 'research_merge', brand: 'brand-a' })
    expect(Object.keys(lines[0]!).sort()).toEqual(['agent', 'body', 'brand', 'createdAt', 'id'])

    const one = run(['--agent', 'research_merge', '--brand', 'brand-b'], env)
    expect(one.code).toBe(0)
    expect(
      one.out
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).body.n),
    ).toEqual([2])

    expect(run(['--agent', 'research_merge', '--brand', 'nope'], env).code).toBe(2)
    expect((await db.admin.query('select count(*)::int as n from app.evaluation_case')).rows[0].n).toBe(
      before,
    )
  })

  it('refuses bad arguments and a missing environment with 2', () => {
    expect(run(['--nope']).code).toBe(2)
    expect(run([]).code).toBe(2)
    expect(run(['--agent', 'Bad Name'], { ADMIN_DATABASE_URL: 'x' }).code).toBe(2)
    expect(run(['--agent', 'strategist']).code).toBe(2)
  })

  it('exits 3 when the database is down, printing no address', () => {
    const r = run(['--agent', 'strategist'], { ADMIN_DATABASE_URL: 'postgres://u:pw-secret@127.0.0.1:1/db' })
    expect(r.code).toBe(3)
    expect(r.out + r.err).not.toContain('pw-secret')
  })
})
