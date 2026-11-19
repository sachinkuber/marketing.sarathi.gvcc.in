import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export const agentDefinitionSchema = z.strictObject({
  agent: z.string().regex(/^[a-z][a-z_]{1,39}$/),
  version: z.number().int().min(1),
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high']),
  maxTokens: z.number().int().min(1).max(64000),
  jobClass: z.enum(['interactive', 'production', 'bulk', 'publishing']),
  resultType: z.string().regex(/^[a-z_]+\.v[0-9]+$/),
  tools: z
    .array(
      z.strictObject({
        type: z.enum(['web_search_20260209', 'web_fetch_20260209']),
        maxUses: z.number().int().min(1).max(50),
      }),
    )
    .optional(),
  caps: z
    .strictObject({
      searchesPerJob: z.number().int().optional(),
      fetchesPerJob: z.number().int().optional(),
      searchesPerBrandStep: z.number().int().optional(),
    })
    .optional(),
})
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>

// Reads an agent's folder: definition.json (checked), system.md and output.schema.json. A refusal names
// the file and the field in plain words.
export function loadAgentDefinition(dir: string) {
  const file = join(dir, 'definition.json')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: could not be read as JSON`, { cause: error })
  }
  const parsed = agentDefinitionSchema.safeParse(raw)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const keys = issue.code === 'unrecognized_keys' ? issue.keys.join(', ') : issue.path.join('.')
      return `${keys === '' ? 'definition' : keys}: ${issue.message}`
    })
    throw new Error(`${file}: ${problems.join('; ')}`)
  }
  const outputFile = join(dir, 'output.schema.json')
  let outputSchema: unknown
  try {
    outputSchema = JSON.parse(readFileSync(outputFile, 'utf8'))
  } catch (error) {
    throw new Error(`${outputFile}: could not be read as JSON`, { cause: error })
  }
  return {
    definition: parsed.data,
    system: readFileSync(join(dir, 'system.md'), 'utf8'),
    outputSchema,
  }
}
export type LoadedAgent = ReturnType<typeof loadAgentDefinition>
