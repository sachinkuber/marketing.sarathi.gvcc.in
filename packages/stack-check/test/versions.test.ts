import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..', '..')

// Copied from docs/tech-stack/2026-10-04-tech-stack.md, version 2.
const pinned: Record<string, string> = {
  '@anthropic-ai/sdk': '0.124.0',
  '@playwright/test': '1.63.0',
  '@sentry/node': '10.73.0',
  'better-auth': '1.7.2',
  eslint: '10.10.0',
  express: '5.2.1',
  helmet: '8.3.0',
  kysely: '0.29.5',
  next: '16.3.4',
  'node-pg-migrate': '8.0.4',
  nodemailer: '9.1.1',
  pg: '8.23.0',
  'pg-boss': '12.30.0',
  pino: '10.3.1',
  'pino-http': '11.0.0',
  prettier: '3.9.6',
  react: '19.2.8',
  'react-dom': '19.2.8',
  'react-hook-form': '7.87.0',
  recharts: '3.10.1',
  tailwindcss: '4.3.3',
  typescript: '5.9.3',
  vitest: '4.1.11',
  zod: '4.5.4',
}

function installedVersion(name: string): string {
  const places = [join(root, 'packages', 'stack-check', 'node_modules'), join(root, 'node_modules')]
  for (const place of places) {
    try {
      return JSON.parse(readFileSync(join(place, name, 'package.json'), 'utf8')).version
    } catch {
      // not in this place; try the next
    }
  }
  throw new Error(`${name} is not installed`)
}

describe('pinned stack', () => {
  it('runs on the pinned Node', () => {
    expect(process.version).toBe('v24.20.0')
  })

  it.each(Object.entries(pinned))('%s is installed at %s', (name, version) => {
    expect(installedVersion(name)).toBe(version)
  })
})
