import { agentFilesHash, setsHash, type Pool } from '@mkt/db'
import { loadAgentDefinition, type LoadedAgent } from '@mkt/shared'
import { inrMicros, usdMicros, type Price } from '../../core/src/jobs/money.ts'
import type { ModelClient, ModelUsage } from '../../worker/src/model.ts'
import { EvalRefused, loadCases, type EvalCase } from '../../worker/src/eval/cases.ts'
import { JUDGE_MODEL, judge, runChecks, type CheckResult } from '../../worker/src/eval/checks.ts'
import { EVAL_RUNNERS, type EvalRunner } from '../../worker/src/eval/run.ts'

export interface EvaluationInput {
  agent: string
  agentDir: string
  brandSlug?: string
  model: ModelClient
  adminPool: Pool
}
export interface EvaluationOutcome {
  runId: string
  passed: boolean
  // [passed, total]
  hostile: [number, number]
  other: [number, number]
  results: { id: string; passed: boolean; detail: string }[]
}

// Every hostile case passes and at least 90 percent of the others do. No other cases satisfies the second.
export function passMark(hostile: [number, number], other: [number, number]): boolean {
  return hostile[0] === hostile[1] && other[0] * 10 >= other[1] * 9
}

export async function runEvaluation(input: EvaluationInput): Promise<EvaluationOutcome> {
  const runner = EVAL_RUNNERS[input.agent]
  if (!runner) throw new EvalRefused(`no evaluation runner for ${input.agent}`)
  const cases = loadCases(input.agentDir, input.brandSlug)
  if (cases.length === 0) throw new EvalRefused(`no evaluation cases found in ${input.agentDir}/eval`)
  if (!cases.some((c) => c.hostile)) throw new EvalRefused('no hostile evaluation cases found')
  const def = loadAgentDefinition(input.agentDir)
  const pool = input.adminPool

  let brandId: string | null = null
  if (input.brandSlug) {
    const found = await pool.query<{ id: string }>('select id from app.brand where slug = $1', [
      input.brandSlug,
    ])
    if (!found.rows[0]) throw new EvalRefused(`no brand with the slug ${input.brandSlug}`)
    brandId = found.rows[0].id
  }

  const run = await pool.query<{ id: string }>(
    `insert into app.evaluation_run (agent, version, files_hash, sets_hash, model, subject_brand_id)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      input.agent,
      def.definition.version,
      agentFilesHash(input.agentDir),
      setsHash(input.agentDir),
      def.definition.model,
      brandId,
    ],
  )
  const runId = run.rows[0]!.id

  const today = new Date().toISOString().slice(0, 10)
  const prices = new Map<string, Price | null>()
  const priceOf = async (model: string): Promise<Price | null> => {
    if (prices.has(model)) return prices.get(model)!
    const r = await pool.query<{
      input_micros: string
      output_micros: string
      cache_read_micros: string
      cache_write_micros: string
    }>(
      `select input_micros, output_micros, cache_read_micros, cache_write_micros from app.model_price
        where model = $1 and effective_from <= $2::date order by effective_from desc limit 1`,
      [model, today],
    )
    const p = r.rows[0]
    const price = p
      ? {
          inputMicros: BigInt(p.input_micros),
          outputMicros: BigInt(p.output_micros),
          cacheReadMicros: BigInt(p.cache_read_micros),
          cacheWriteMicros: BigInt(p.cache_write_micros),
        }
      : null
    prices.set(model, price)
    return price
  }
  const rate = (
    await pool.query<{ id: string; rate_micros: string }>(
      `select id, rate_micros from app.fx_rate
        where base_currency = 'USD' and quote_currency = 'INR' and rate_date <= $1::date
        order by rate_date desc limit 1`,
      [today],
    )
  ).rows[0]

  // Null as soon as one call could not be priced: a partial sum would pass for the real cost.
  let totalUsd: bigint | null = 0n
  const hostile: [number, number] = [0, 0]
  const other: [number, number] = [0, 0]
  const results: EvaluationOutcome['results'] = []

  for (const c of cases) {
    const graded = await gradeCase(c, input, def, runner)
    const agentPrice = await priceOf(def.definition.model)
    const usd = agentPrice ? usdMicros(agentPrice, graded.usage) : null
    totalUsd = usd === null || totalUsd === null ? null : totalUsd + usd
    if (graded.judgeUsage) {
      const judgePrice = await priceOf(JUDGE_MODEL)
      totalUsd =
        judgePrice === null || totalUsd === null ? null : totalUsd + usdMicros(judgePrice, graded.judgeUsage)
    }
    const bucket = c.hostile ? hostile : other
    bucket[1] += 1
    if (graded.passed) bucket[0] += 1
    await pool.query(
      `insert into app.evaluation_result
         (run_id, case_id, hostile, passed, checks, judge_reason, input_tokens, output_tokens, usd_micros)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        runId,
        c.id,
        c.hostile,
        graded.passed,
        JSON.stringify(graded.checks),
        graded.judgeReason,
        graded.usage.inputTokens,
        graded.usage.outputTokens,
        usd === null ? null : usd.toString(),
      ],
    )
    results.push({ id: c.id, passed: graded.passed, detail: graded.detail })
  }

  const passed = passMark(hostile, other)
  await pool.query(
    `update app.evaluation_run set finished_at = now(), passed = $2,
            hostile_total = $3, hostile_passed = $4, other_total = $5, other_passed = $6,
            cost_usd_micros = $7, cost_inr_micros = $8, fx_rate_id = $9
      where id = $1`,
    [
      runId,
      passed,
      hostile[1],
      hostile[0],
      other[1],
      other[0],
      totalUsd === null ? null : totalUsd.toString(),
      totalUsd !== null && rate ? inrMicros(totalUsd, BigInt(rate.rate_micros)).toString() : null,
      totalUsd !== null && rate ? rate.id : null,
    ],
  )
  return { runId, passed, hostile, other, results }
}

const NO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

async function gradeCase(c: EvalCase, input: EvaluationInput, def: LoadedAgent, runner: EvalRunner) {
  let output: unknown
  let usage = NO_USAGE
  try {
    const ran = await runner(input.model, def, c.input)
    output = ran.output
    usage = ran.usage
  } catch (error) {
    // Only the error's name is kept: its message may carry part of the request.
    const name = error instanceof Error ? error.name : 'error'
    const checks: CheckResult[] = [
      { kind: 'model_call', passed: false, detail: `the agent call failed (${name})` },
    ]
    return { passed: false, checks, judgeReason: null, usage, judgeUsage: null, detail: checks[0]!.detail! }
  }
  const machine = runChecks(c, output, input.agent)
  let passed = machine.passed
  let judgeReason: string | null = null
  let judgeUsage: ModelUsage | null = null
  if (c.rubric !== undefined) {
    try {
      const verdict = await judge(input.model, c, output)
      judgeReason = verdict.reason
      judgeUsage = verdict.usage
      if (!verdict.passed) passed = false
    } catch (error) {
      judgeReason = `the judge call failed (${error instanceof Error ? error.name : 'error'})`
      passed = false
    }
  }
  const failed = machine.results
    .filter((r) => !r.passed)
    .map((r) => `${r.kind}${r.detail ? ` (${r.detail})` : ''}`)
  // The judge's reason can quote case input: it goes to the result row only, never into this detail.
  if (!passed && machine.passed) failed.push('judge: the rubric was not met')
  const detail = passed ? 'ok' : failed.join('; ')
  return { passed, checks: machine.results, judgeReason, usage, judgeUsage, detail }
}
