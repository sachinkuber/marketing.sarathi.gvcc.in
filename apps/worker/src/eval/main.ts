import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createPool } from '@mkt/db'
import { anthropicModel } from '../anthropic.ts'
import { EvalRefused } from './cases.ts'
import { EVAL_RUNNERS, runEvaluation } from './run.ts'

// npm run eval -- --agent <name> [--brand <slug>]. Exit 0 passed, 1 failed, 2 refused. Nothing printed names
// the key, the database address or a case input: a line is the case id and a short verdict.
async function main(): Promise<number> {
  let values: { agent?: string; brand?: string }
  try {
    values = parseArgs({
      options: { agent: { type: 'string' }, brand: { type: 'string' } },
      strict: true,
    }).values
  } catch {
    console.error('usage: npm run eval -- --agent <name> [--brand <slug>]')
    return 2
  }
  const agent = values.agent
  if (!agent || !/^[a-z][a-z_]{1,39}$/.test(agent) || !EVAL_RUNNERS[agent]) {
    console.error('unknown agent: name one with an evaluation runner')
    return 2
  }
  const agentDir = fileURLToPath(new URL(`../../../../agents/${agent}/`, import.meta.url))
  if (!existsSync(agentDir)) {
    console.error('unknown agent: no folder under agents/')
    return 2
  }
  const databaseUrl = process.env['ADMIN_DATABASE_URL']
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!databaseUrl || !apiKey) {
    console.error('ADMIN_DATABASE_URL and ANTHROPIC_API_KEY must be set')
    return 2
  }
  const pool = createPool(databaseUrl)
  try {
    const out = await runEvaluation({
      agent,
      agentDir,
      ...(values.brand ? { brandSlug: values.brand } : {}),
      model: anthropicModel(apiKey),
      adminPool: pool,
    })
    for (const r of out.results) console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.id}: ${r.detail}`)
    console.log(
      JSON.stringify({
        event: 'evaluation_done',
        runId: out.runId,
        passed: out.passed,
        hostile: out.hostile,
        other: out.other,
      }),
    )
    return out.passed ? 0 : 1
  } catch (error) {
    if (error instanceof EvalRefused) {
      console.error(error.message)
      return 2
    }
    console.error(`evaluation failed (${error instanceof Error ? error.name : 'error'})`)
    return 2
  } finally {
    await pool.end()
  }
}

if (import.meta.main) process.exit(await main())
