import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFilesHash, SUMMARY_AGENT_DIR } from './agent-files-hash.ts'

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hash-'))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  return dir
}

describe('agentFilesHash', () => {
  it('does not depend on creation order, and changes with content or path', () => {
    const a = agentFilesHash(dirWith({ 'a.txt': '1', 'b.txt': '2' }))
    expect(agentFilesHash(dirWith({ 'b.txt': '2', 'a.txt': '1' }))).toBe(a)
    expect(agentFilesHash(dirWith({ 'a.txt': '1', 'b.txt': '3' }))).not.toBe(a)
    expect(agentFilesHash(dirWith({ 'a.txt': '1', 'c.txt': '2' }))).not.toBe(a)
  })
  it('separates a path from the bytes with a NUL', () => {
    expect(agentFilesHash(dirWith({ a: 'bc' }))).not.toBe(agentFilesHash(dirWith({ ab: 'c' })))
  })
  it('hashes the three summary agent files', () => {
    expect(agentFilesHash(SUMMARY_AGENT_DIR)).toMatch(/^[0-9a-f]{64}$/)
  })
})
