import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFilesHash, setsHash } from '../src/agent-files.ts'
import { SUMMARY_AGENT_DIR } from './agent-files-hash.ts'

describe('agent files hash', () => {
  it('is unchanged for the summary agent', () => {
    expect(agentFilesHash(SUMMARY_AGENT_DIR)).toBe(
      'dcd031ab2a59622899a2fe9121969442c20a5fff8ac216c4f4e35fc24f1427f0',
    )
  })

  it('leaves eval/ out of the agent hash but not out of the sets hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-files-'))
    writeFileSync(join(dir, 'system.md'), 'a')
    mkdirSync(join(dir, 'eval'))
    const before = { agent: agentFilesHash(dir), sets: setsHash(dir) }
    writeFileSync(join(dir, 'eval', 'case1.json'), '{}')
    expect(agentFilesHash(dir)).toBe(before.agent)
    expect(setsHash(dir)).not.toBe(before.sets)
  })

  it('takes an explicit exclude list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-files-'))
    writeFileSync(join(dir, 'a.md'), 'a')
    mkdirSync(join(dir, 'eval'))
    writeFileSync(join(dir, 'eval', 'c.json'), '{}')
    expect(agentFilesHash(dir, { exclude: [] })).not.toBe(agentFilesHash(dir))
  })
})
