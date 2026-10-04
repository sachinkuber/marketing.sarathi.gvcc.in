import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTORS, PERMISSIONS, PERMISSION_KEYS, grantFor, type Grant } from '../src/access/permissions.ts'

const PRD = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'prd',
  '2026-10-03-ai-marketing-agency-prd.md',
)

// The PRD's access table (section 16.1), read as written, so the code cannot drift from it.
function prdTable(): { header: string[]; rows: { label: string; cells: string[] }[] } {
  const lines = readFileSync(PRD, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.startsWith('| Permission | Platform owner |'))
  expect(start, 'the PRD access table was not found').toBeGreaterThan(-1)
  const cells = (line: string) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
  const rows: { label: string; cells: string[] }[] = []
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break
    const parts = cells(line)
    rows.push({ label: parts[0] as string, cells: parts.slice(1) })
  }
  return { header: cells(lines[start] as string), rows }
}

const FROM_PRD: Record<string, Grant> = { Yes: 'all', No: false, 'Own leads': 'own' }

describe('the permission matrix', () => {
  it('reads the PRD columns in the order the code assumes', () => {
    expect(prdTable().header).toEqual([
      'Permission',
      'Platform owner',
      'Brand admin',
      'Brand approver',
      'Sales contact',
      'Viewer',
      'Partner',
    ])
    expect(ACTORS).toEqual(['platform_owner', 'brand_admin', 'approver', 'sales_contact', 'viewer'])
  })

  it('has exactly the PRD rows, by their exact labels', () => {
    const labels = prdTable().rows.map((row) => row.label)
    expect(labels).toHaveLength(10)
    expect(PERMISSION_KEYS.map((key) => PERMISSIONS[key].label)).toEqual(labels)
  })

  it('grants every role exactly what the PRD table says (the partner has no account and is not a role)', () => {
    for (const row of prdTable().rows) {
      const key = PERMISSION_KEYS.find((candidate) => PERMISSIONS[candidate].label === row.label)
      expect(key, row.label).toBeDefined()
      ACTORS.forEach((actor, index) => {
        const cell = row.cells[index] as string
        expect(
          FROM_PRD[cell],
          `${row.label} / ${actor}: "${cell}" is not a value this test understands`,
        ).not.toBeUndefined()
        expect(grantFor(actor, key!), `${row.label} / ${actor}`).toBe(FROM_PRD[cell])
      })
    }
  })

  it('lets only the platform owner see other brands, and a sales contact see only their own leads', () => {
    expect(ACTORS.filter((actor) => grantFor(actor, 'see_other_brands'))).toEqual(['platform_owner'])
    expect(grantFor('sales_contact', 'view_lead_data')).toBe('own')
    expect(grantFor('viewer', 'manage_users')).toBe(false)
  })
})
