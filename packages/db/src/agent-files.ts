import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function listFiles(dir: string): string[] {
  const files: string[] = []
  const walk = (sub: string) => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const rel = sub === '' ? entry.name : `${sub}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else files.push(rel)
    }
  }
  walk('')
  return files.sort()
}

function hashOf(dir: string, files: string[]): string {
  const hash = createHash('sha256')
  for (const rel of files) {
    hash.update(rel)
    hash.update(Buffer.from([0]))
    hash.update(readFileSync(join(dir, rel)))
  }
  return hash.digest('hex')
}

const underAny = (rel: string, folders: string[]) => folders.some((folder) => rel.startsWith(`${folder}/`))

// SHA-256 over the sorted relative paths of every file under dir, each followed by a NUL and the file's bytes.
// The eval/ folder is left out by default: evaluation cases change without the agent changing.
export function agentFilesHash(dir: string, options: { exclude?: string[] } = {}): string {
  const exclude = options.exclude ?? ['eval']
  return hashOf(
    dir,
    listFiles(dir).filter((rel) => !underAny(rel, exclude)),
  )
}

// The same hash over only the eval/ folder.
export function setsHash(dir: string): string {
  return hashOf(
    dir,
    listFiles(dir).filter((rel) => underAny(rel, ['eval'])),
  )
}
