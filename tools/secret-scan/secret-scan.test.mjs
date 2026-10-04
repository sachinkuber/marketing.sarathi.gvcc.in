import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

function scan(dir) {
  return spawnSync('gitleaks', ['dir', '--no-banner', '--redact', '--config', '.gitleaks.toml', dir], {
    encoding: 'utf8',
  })
}

describe('secret scanner', () => {
  let dir
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('fails on a planted token', () => {
    dir = mkdtempSync(join(tmpdir(), 'scan-'))
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9' + 'J0k1L2m3N4o5P6q7R8'
    writeFileSync(join(dir, 'settings.env'), `GITHUB_TOKEN=${token}\n`)
    expect(scan(dir).status).toBe(1)
  })

  it('passes on a clean folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'scan-'))
    writeFileSync(join(dir, 'readme.txt'), 'nothing secret here\n')
    expect(scan(dir).status).toBe(0)
  })
})
