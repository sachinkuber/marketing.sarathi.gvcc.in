import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkRepo, findUnpinned } from './check-pins.mjs'

describe('findUnpinned', () => {
  it('accepts exact versions', () => {
    const pkg = { dependencies: { a: '1.2.3' }, devDependencies: { b: '10.0.1' } }
    expect(findUnpinned(pkg)).toEqual([])
  })

  it.each(['^1.2.3', '~1.2.3', '*', 'latest', '1.x', '>=1.0.0', 'github:user/repo', 'file:../x', ''])(
    'rejects %j',
    (spec) => {
      expect(findUnpinned({ dependencies: { a: spec } })).toEqual([
        { section: 'dependencies', name: 'a', spec },
      ])
    },
  )

  it('allows * only for a package in this workspace', () => {
    const pkg = { dependencies: { '@mkt/local': '*', other: '*' } }
    expect(findUnpinned(pkg, new Set(['@mkt/local']))).toEqual([
      { section: 'dependencies', name: 'other', spec: '*' },
    ])
  })

  it('checks optional dependencies too', () => {
    expect(findUnpinned({ optionalDependencies: { a: '^1.0.0' } })).toHaveLength(1)
  })
})

describe('checkRepo', () => {
  let dir
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds a range in a nested package and ignores node_modules', () => {
    dir = mkdtempSync(join(tmpdir(), 'pins-'))
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', devDependencies: { a: '1.0.0' } }),
    )
    mkdirSync(join(dir, 'packages', 'x'), { recursive: true })
    writeFileSync(
      join(dir, 'packages', 'x', 'package.json'),
      JSON.stringify({ name: '@mkt/x', dependencies: { b: '^2.0.0', root: '*' } }),
    )
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(
      join(dir, 'node_modules', 'dep', 'package.json'),
      JSON.stringify({ dependencies: { c: '^3.0.0' } }),
    )

    expect(checkRepo(dir)).toEqual([
      {
        file: join('packages', 'x', 'package.json'),
        problems: [{ section: 'dependencies', name: 'b', spec: '^2.0.0' }],
      },
    ])
  })
})
