import { expect } from 'vitest'
import { MemoryExportStore, type ExportMark } from '../src/audit/store.ts'
import { StandInFxSource } from '../src/triggers/fx.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

export const PASSWORD = 'correct horse battery'
// The service's clock in these tests: this month is October 2026.
export const NOW = new Date('2026-10-20T12:00:00Z')
export const api = (brandId: string, tail: string) => `/api/v1/brands/${brandId}${tail}`

// An export store whose marks can be made to disagree with the log, as a tampered copy would.
export class TamperedStore extends MemoryExportStore {
  tamper = false
  override async marks(chainKey: string): Promise<ExportMark[]> {
    const marks = await super.marks(chainKey)
    return this.tamper ? marks.map((m) => ({ ...m, chainHash: 'sha256:' + 'f'.repeat(64) })) : marks
  }
}

// The clock moves only when a test says so (a verify is allowed once a minute per chain).
let offset = 0
export const advance = (ms = 61_000): void => {
  offset += ms
}

export async function readsStack(
  store: MemoryExportStore | null = new MemoryExportStore(),
  options: { withQueue?: boolean; verifyTimeoutMs?: number } = {},
): Promise<Stack> {
  return createStack({
    realAudit: true,
    withQueue: options.withQueue,
    clock: { now: () => new Date(NOW.getTime() + offset) },
    daily: { fx: new StandInFxSource(83_000_000n), store, verifyTimeoutMs: options.verifyTimeoutMs },
  })
}

export interface Cast {
  brandId: string
  owner: TestClient
  admin: TestClient
  approver: TestClient
  viewer: TestClient
  stranger: TestClient
  adminId: string
}

let counter = 0
// A brand with an admin, an approver and a viewer, a platform owner, and a stranger who belongs to another
// brand only.
export async function cast(stack: Stack, ownerTag?: string): Promise<Cast> {
  counter += 1
  const tag = `${ownerTag ?? 'r'}${counter}`
  const brandId = await addBrand(stack, `brand-${tag}`)
  const other = await addBrand(stack, `other-${tag}`)
  const adminId = await addUser(stack, {
    email: `admin-${tag}@example.test`,
    password: PASSWORD,
    role: 'brand_admin',
    brandId,
  })
  await addUser(stack, {
    email: `approver-${tag}@example.test`,
    password: PASSWORD,
    role: 'approver',
    brandId,
  })
  await addUser(stack, { email: `viewer-${tag}@example.test`, password: PASSWORD, role: 'viewer', brandId })
  await addUser(stack, { email: `owner-${tag}@example.test`, password: PASSWORD, platformOwner: true })
  await addUser(stack, {
    email: `stranger-${tag}@example.test`,
    password: PASSWORD,
    role: 'brand_admin',
    brandId: other,
  })
  const client = async (who: string) =>
    (await enrolledClient(stack, `${who}-${tag}@example.test`, PASSWORD)).client
  return {
    brandId,
    adminId,
    owner: await client('owner'),
    admin: await client('admin'),
    approver: await client('approver'),
    viewer: await client('viewer'),
    stranger: await client('stranger'),
  }
}

// owner, admin, approver, viewer, stranger
export async function statuses(
  c: Cast,
  method: string,
  path: string,
  body?: unknown,
  between?: () => void,
): Promise<[number, number, number, number, number]> {
  const out: number[] = []
  for (const who of [c.owner, c.admin, c.approver, c.viewer, c.stranger]) {
    between?.()
    out.push((await who.request(method, path, { body })).status)
  }
  return out as [number, number, number, number, number]
}

export async function liveSummaryDefinition(stack: Stack): Promise<string> {
  const { rows } = await stack.db.admin.query(
    `select id from app.agent_definition_version where agent = 'summary' and live`,
  )
  return rows[0].id as string
}

export interface RunSeed {
  agent?: string
  state?: string
  startedAt?: Date
  usd?: bigint
  inr?: bigint
}

export async function fxRateId(stack: Stack): Promise<string> {
  const rate = await stack.db.admin.query(
    `insert into app.fx_rate (rate_date, rate_micros, source) values ('2026-10-01', 83000000, 'test')
     on conflict (rate_date, base_currency, quote_currency) do update set source = 'test' returning id`,
  )
  return rate.rows[0].id as string
}

export async function seedRun(stack: Stack, brandId: string, seed: RunSeed = {}): Promise<string> {
  const def = await liveSummaryDefinition(stack)
  const startedAt = seed.startedAt ?? new Date(NOW.getTime() - 3_600_000)
  const state = seed.state ?? 'succeeded'
  const { rows } = await stack.db.admin.query(
    `insert into app.run (brand_id, agent, definition_version_id, state, started_by_kind, started_at, finished_at)
     values ($1, $2, $3, $4, 'system', $5, $6) returning id`,
    [
      brandId,
      seed.agent ?? 'summary',
      def,
      state,
      startedAt,
      ['running', 'created'].includes(state) ? null : startedAt,
    ],
  )
  const runId = rows[0].id as string
  if (seed.usd !== undefined) {
    const rateId = await fxRateId(stack)
    await stack.db.admin.query(
      `insert into app.cost_ledger (brand_id, run_id, agent, charged_micros, charged_currency, usd_micros, inr_micros, fx_rate_id, at)
       values ($1, $2, $3, $4, 'USD', $4, $5, $6, $7)`,
      [brandId, runId, seed.agent ?? 'summary', seed.usd, seed.inr ?? seed.usd * 83n, rateId, startedAt],
    )
  }
  return runId
}

export interface JobSeed {
  finished?: boolean
  held?: boolean
  dead?: boolean
  attempts?: ('active' | 'succeeded' | 'failed')[]
}

export async function seedJob(stack: Stack, brandId: string, runId: string, seed: JobSeed = {}) {
  const { rows } = await stack.db.admin.query(
    `insert into app.job_input (job_id, brand_id, run_id, class, input, expected_result_type, finished_at)
     values (gen_random_uuid(), $1, $2, 'interactive', '{}', 'test.echo', $3) returning job_id`,
    [brandId, runId, seed.finished ? NOW : null],
  )
  const jobId = rows[0].job_id as string
  await stack.db.admin.query(
    `insert into app.job_control (job_id, brand_id, held, dead_at) values ($1, $2, $3, $4)`,
    [jobId, brandId, seed.held ?? false, seed.dead ? NOW : null],
  )
  let n = 0
  for (const state of seed.attempts ?? []) {
    n += 1
    await stack.db.admin.query(
      `insert into app.job_attempt (brand_id, job_id, attempt_number, worker_id, token_id, state, ended_at)
       values ($1, $2, $3, 'w1', gen_random_uuid(), $4, $5)`,
      [brandId, jobId, n, state, state === 'active' ? null : NOW],
    )
  }
  return jobId
}

export interface CallSeed {
  status?: 'started' | 'succeeded' | 'failed' | 'unknown'
  possibleDuplicate?: boolean
  cost?: boolean
}

export async function seedCall(stack: Stack, brandId: string, runId: string, seed: CallSeed = {}) {
  const jobId = await seedJob(stack, brandId, runId, { attempts: ['succeeded'] })
  const attempt = await stack.db.admin.query('select id from app.job_attempt where job_id = $1', [jobId])
  const status = seed.status ?? 'succeeded'
  const { rows } = await stack.db.admin.query(
    `insert into app.model_call (brand_id, run_id, job_id, attempt_id, step, request_hash, status, possible_duplicate,
        model, input_tokens, output_tokens, usd_micros, inr_micros, started_at)
     values ($1, $2, $3, $4, 'draft', gen_random_uuid()::text, $5, $6, 'claude-opus-5-5', 100, 50, $7, $8, now()) returning id`,
    [
      brandId,
      runId,
      jobId,
      attempt.rows[0].id,
      status,
      seed.possibleDuplicate ?? false,
      status === 'succeeded' ? 1_500_000n : null,
      status === 'succeeded' ? 124_500_000n : null,
    ],
  )
  return rows[0].id as string
}

export async function seedAwaiting(stack: Stack, brandId: string, since: Date): Promise<string> {
  const client = await stack.db.admin.connect()
  try {
    await client.query('set session_replication_role = replica')
    const item = await client.query(
      `insert into app.content_item (brand_id, kind) values ($1, 'article') returning id`,
      [brandId],
    )
    const version = await client.query(
      `insert into app.content_version (brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by_kind)
       values ($1, $2, 1, '{"title":"t"}', 'h', 'cv1', 'system') returning id`,
      [brandId, item.rows[0].id],
    )
    await client.query(
      `insert into app.content_version_state (content_version_id, brand_id, state, updated_at)
       values ($1, $2, 'awaiting_approval', $3)`,
      [version.rows[0].id, brandId, since],
    )
    return version.rows[0].id as string
  } finally {
    await client.query('reset session_replication_role')
    client.release()
  }
}

export function expectMoneyStrings(value: unknown, path = ''): void {
  if (Array.isArray(value)) value.forEach((v, i) => expectMoneyStrings(v, `${path}[${i}]`))
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (/micros$/i.test(key) && v !== null) {
        expect(typeof v, `${path}.${key}`).toBe('string')
        expect(v as string).toMatch(/^\d+$/)
      } else expectMoneyStrings(v, `${path}.${key}`)
    }
  }
}
