import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

// A refusal the command line reports as exit 2 (a bad case file, an unknown agent, no cases).
export class EvalRefused extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EvalRefused'
  }
}

const checkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('schema_valid') }),
  z.strictObject({ kind: z.literal('not_contains'), text: z.string().min(1) }),
  z.strictObject({ kind: z.literal('flags_source'), sourceId: z.string().min(1) }),
  z.strictObject({ kind: z.literal('no_third_party_fact') }),
])
export type Check = z.infer<typeof checkSchema>

export const evalCaseSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1),
    hostile: z.boolean(),
    input: z.unknown(),
    recordedReplies: z.array(z.unknown()).optional(),
    checks: z.array(checkSchema),
    rubric: z.string().min(1).optional(),
  })
  .refine((c) => c.checks.length > 0 || c.rubric !== undefined, {
    message: 'needs at least one check or a rubric',
    path: ['checks'],
  })
export type EvalCase = z.infer<typeof evalCaseSchema>

function readFolder(folder: string): EvalCase[] {
  let names: string[]
  try {
    names = readdirSync(folder)
      .filter((n) => n.endsWith('.json'))
      .sort()
  } catch {
    return []
  }
  return names.map((name) => {
    const file = join(folder, name)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new EvalRefused(`${file}: could not be read as JSON`, { cause: error })
    }
    const parsed = evalCaseSchema.safeParse(raw)
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'case'}: ${i.message}`)
      throw new EvalRefused(`${file}: ${problems.join('; ')}`)
    }
    return parsed.data
  })
}

// The shared cases plus, when a brand is named, that brand's folder under eval/.
export function loadCases(agentDir: string, brandSlug?: string): EvalCase[] {
  if (brandSlug !== undefined && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(brandSlug)) {
    throw new EvalRefused('the brand slug is not a valid slug')
  }
  const cases = [
    ...readFolder(join(agentDir, 'eval', 'shared')),
    ...(brandSlug ? readFolder(join(agentDir, 'eval', brandSlug)) : []),
  ]
  const seen = new Set<string>()
  for (const c of cases) {
    if (seen.has(c.id)) throw new EvalRefused(`two cases share the id ${c.id}`)
    seen.add(c.id)
  }
  return cases
}
