import { parseArgs } from 'node:util'
import pg from 'pg'

// `cases --agent <name> [--brand <slug>]`: the candidate evaluation cases, one JSON line each, oldest first.
// It writes nothing: a developer turns them into case files in a reviewed pull request (spec 11). Exit codes:
// 0 listed, 2 refused (bad arguments or environment), 3 unexpected error.
export interface CandidateCase {
  id: string
  agent: string
  brand: string | null
  createdAt: string
  body: unknown
}

export class CasesRefused extends Error {
  override name = 'CasesRefused'
}

export async function listCandidateCases(
  adminUrl: string,
  input: { agent: string; brandSlug?: string },
): Promise<CandidateCase[]> {
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    let brandId: string | null = null
    if (input.brandSlug !== undefined) {
      const found = await client.query<{ id: string }>('select id from app.brand where slug = $1', [
        input.brandSlug,
      ])
      brandId = found.rows[0]?.id ?? null
      if (!brandId) throw new CasesRefused('no brand has that slug; check --brand')
    }
    const { rows } = await client.query<{
      id: string
      agent: string
      slug: string | null
      created_at: Date
      body: unknown
    }>(
      `select c.id, c.agent, b.slug, c.created_at, c.body
         from app.evaluation_case c left join app.brand b on b.id = c.subject_brand_id
        where c.status = 'candidate' and c.agent = $1 and ($2::uuid is null or c.subject_brand_id = $2)
        order by c.created_at, c.id`,
      [input.agent, brandId],
    )
    return rows.map((r) => ({
      id: r.id,
      agent: r.agent,
      brand: r.slug,
      createdAt: r.created_at.toISOString(),
      body: r.body,
    }))
  } finally {
    await client.end()
  }
}

export async function casesFromEnv(env: Record<string, string | undefined>, args: string[]): Promise<number> {
  let values: { agent?: string; brand?: string }
  try {
    values = parseArgs({
      args,
      options: { agent: { type: 'string' }, brand: { type: 'string' } },
      strict: true,
    }).values
  } catch {
    process.stderr.write('usage: ops cases --agent <name> [--brand <slug>]\n')
    return 2
  }
  if (!values.agent || !/^[a-z][a-z_]{1,39}$/.test(values.agent)) {
    process.stderr.write('name an agent with --agent: 2 to 40 lowercase letters and underscores\n')
    return 2
  }
  const adminUrl = env['ADMIN_DATABASE_URL']
  if (!adminUrl) {
    process.stderr.write('ADMIN_DATABASE_URL must be set\n')
    return 2
  }
  try {
    const found = await listCandidateCases(adminUrl, {
      agent: values.agent,
      ...(values.brand !== undefined ? { brandSlug: values.brand } : {}),
    })
    for (const c of found) process.stdout.write(`${JSON.stringify(c)}\n`)
    return 0
  } catch (error) {
    if (error instanceof CasesRefused) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
    process.stderr.write(`cases failed (${error instanceof Error ? error.name : 'error'})\n`)
    return 3
  }
}
