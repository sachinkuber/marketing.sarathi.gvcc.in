// Removes from node_modules every package a workspace reaches only through an optional peer dependency.
// Used by infra/prod/Dockerfile after `npm ci --omit=dev --workspace <ws>`: npm's workspace filter follows optional
// peer edges, so better-auth's optional peers (next, react, react-dom, vitest, playwright...) were installed into
// the core image although nothing the core runs imports them.
// Usage (from the directory holding package-lock.json): node prune-optional-peers.mjs apps/core
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

const workspace = process.argv[2]
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages
if (!workspace || !lock[workspace]) throw new Error(`Unknown workspace: ${workspace}`)

// npm's lookup: <from>/node_modules/<name>, then one nesting level up, ..., then node_modules/<name>.
function resolve(from, name) {
  let base = from
  for (;;) {
    const key = `${base ? `${base}/` : ''}node_modules/${name}`
    if (lock[key]) return key
    if (!base) return null
    const i = base.lastIndexOf('/node_modules/')
    base = i < 0 ? '' : base.slice(0, i)
  }
}

const reached = new Set()
const stack = [workspace]
while (stack.length > 0) {
  const key = stack.pop()
  if (reached.has(key)) continue
  reached.add(key)
  const entry = lock[key] ?? {}
  if (entry.link) {
    stack.push(entry.resolved)
    continue
  }
  const optionalPeer = (name) => entry.peerDependenciesMeta?.[name]?.optional === true
  const names = [
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...Object.keys(entry.peerDependencies ?? {}).filter((name) => !optionalPeer(name)),
  ]
  for (const name of names) {
    const target = resolve(key, name)
    if (target) stack.push(target)
  }
}

const removed = []
for (const key of Object.keys(lock)) {
  if (!key.startsWith('node_modules/') || reached.has(key) || !existsSync(key)) continue
  rmSync(key, { recursive: true, force: true })
  removed.push(key.slice('node_modules/'.length))
  // A scope directory (node_modules/@next) left empty goes too.
  const parent = dirname(key)
  if (/(^|\/)@[^/]+$/.test(parent) && existsSync(parent) && readdirSync(parent).length === 0)
    rmdirSync(parent)
}
console.log(`${workspace}: removed ${removed.length} packages reached only through optional peers`)
