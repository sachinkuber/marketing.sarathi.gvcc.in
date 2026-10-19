import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// SHA-256 over the sorted relative paths of every file under dir, each followed by a NUL and the file's bytes.
export function agentFilesHash(dir: string): string {
  const files: string[] = []
  const walk = (sub: string) => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const rel = sub === '' ? entry.name : `${sub}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else files.push(rel)
    }
  }
  walk('')
  files.sort()
  const hash = createHash('sha256')
  for (const rel of files) {
    hash.update(rel)
    hash.update(Buffer.from([0]))
    hash.update(readFileSync(join(dir, rel)))
  }
  return hash.digest('hex')
}

export const SUMMARY_AGENT_DIR = new URL('../../../agents/summary', import.meta.url).pathname
