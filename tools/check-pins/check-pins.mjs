// Fails when any package.json in the repository has a dependency that is not an exact version.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXACT = /^\d+\.\d+\.\d+$/
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies']
const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'coverage'])

export function findUnpinned(pkg, localNames = new Set()) {
  const problems = []
  for (const section of SECTIONS) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      if (spec === '*' && localNames.has(name)) continue
      if (!EXACT.test(spec)) problems.push({ section, name, spec })
    }
  }
  return problems
}

function packageFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) packageFiles(join(dir, entry.name), found)
    } else if (entry.name === 'package.json') {
      found.push(join(dir, entry.name))
    }
  }
  return found
}

export function checkRepo(root) {
  const files = packageFiles(root)
  const packages = files.map((file) => ({ file, pkg: JSON.parse(readFileSync(file, 'utf8')) }))
  const localNames = new Set(packages.map(({ pkg }) => pkg.name).filter(Boolean))
  return packages
    .map(({ file, pkg }) => ({ file: relative(root, file), problems: findUnpinned(pkg, localNames) }))
    .filter(({ problems }) => problems.length > 0)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = checkRepo(process.cwd())
  for (const { file, problems } of failures) {
    for (const { section, name, spec } of problems) {
      console.error(`${file}: ${section}.${name} is "${spec}", not an exact version`)
    }
  }
  if (failures.length > 0) process.exit(1)
  console.log('All dependency versions are exact.')
}
