import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const root = new URL('../../../', import.meta.url).pathname

async function ruleIds(filePath: string, code: string) {
  const eslint = new ESLint({ cwd: root })
  const [result] = await eslint.lintText(code, { filePath: `${root}${filePath}` })
  return result!.messages.map((m) => m.ruleId)
}

describe('business queries must go through withBrand (acceptance test 7)', () => {
  it('rejects importing pg in application code', async () => {
    expect(await ruleIds('apps/core/src/x.ts', "import pg from 'pg'\nexport const p = pg\n")).toContain(
      'no-restricted-imports',
    )
  })

  it('rejects importing kysely and pg-boss in application code', async () => {
    expect(
      await ruleIds('apps/worker/src/x.ts', "import { Kysely } from 'kysely'\nexport const k = Kysely\n"),
    ).toContain('no-restricted-imports')
    expect(
      await ruleIds('apps/worker/src/y.ts', "import { PgBoss } from 'pg-boss'\nexport const q = PgBoss\n"),
    ).toContain('no-restricted-imports')
  })

  it('allows the same imports inside the db package', async () => {
    expect(await ruleIds('packages/db/src/x.ts', "import pg from 'pg'\nexport const p = pg\n")).not.toContain(
      'no-restricted-imports',
    )
  })
})
