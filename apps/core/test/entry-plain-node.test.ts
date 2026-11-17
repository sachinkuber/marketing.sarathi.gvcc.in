import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// Production runs `node <file>` with no flags. Node strips types only; syntax that needs a transform
// (parameter properties, enums) fails there. An empty environment must reach the configuration check.
const entries = [
  ['core', '../src/main.ts'],
  ['worker', '../../worker/src/main.ts'],
] as const

describe('plain node starts both services', () => {
  for (const [name, path] of entries) {
    it(`${name} reaches the configuration error, not a syntax error`, () => {
      const result = spawnSync(process.execPath, [new URL(path, import.meta.url).pathname], {
        env: {},
        encoding: 'utf8',
        timeout: 60_000,
      })
      expect(result.stderr).not.toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX')
      expect(result.stderr).toContain('Invalid configuration:')
      expect(result.status).not.toBe(0)
    })
  }
})
