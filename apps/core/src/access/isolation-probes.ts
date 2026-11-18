// The HTTP half of the tenant-isolation acceptance tests, as functions: test 1 (no brand-scoped route answers
// for a brand the person is not in) and test 6 (an attempt token for one job cannot reach another job). The
// tests (apps/core/test/cross-brand.test.ts, worker-attempts.test.ts) run them against a test core; the restore
// drill (apps/ops/src/restore-check.ts) runs them against a core started on a restored copy. Each returns its
// findings, one line per failed route or job, naming the route pattern and status only, never a row or an id.

export interface ProbeRoute {
  method: string
  path: string
}

export interface ProbeReply {
  status: number
  text: string
}

// One request with the probing person's session; `body` is undefined for a GET.
export type ProbeRequest = (method: string, path: string, body: unknown) => Promise<ProbeReply>

// The routes under /brands/:brandId, from the core's route table.
export function brandScopedRoutes(table: { list(): readonly ProbeRoute[] }): ProbeRoute[] {
  return table
    .list()
    .filter((r) => r.path.includes(':brandId'))
    .map((r) => ({ method: r.method, path: r.path }))
}

const bodyFor = (route: ProbeRoute) => (route.method === 'get' ? undefined : {})

function errorCode(text: string): string | null {
  try {
    return (JSON.parse(text) as { error?: { code?: string } })?.error?.code ?? null
  } catch {
    return null
  }
}

// Test 1: with `fill` putting a brand the person is not in into each path, every route answers 404
// not_found, and the reply does not name that brand.
export async function otherBrandFindings(
  routes: readonly ProbeRoute[],
  request: ProbeRequest,
  fill: (path: string) => string,
  otherBrand: string,
): Promise<string[]> {
  const findings: string[] = []
  for (const route of routes) {
    const reply = await request(route.method.toUpperCase(), `/api/v1${fill(route.path)}`, bodyFor(route))
    if (reply.status !== 404) findings.push(`${route.method} ${route.path}: ${reply.status}, not 404`)
    else if (reply.text.includes(otherBrand)) findings.push(`${route.method} ${route.path}: names the brand`)
    else if (errorCode(reply.text) !== 'not_found')
      findings.push(`${route.method} ${route.path}: not not_found`)
  }
  return findings
}

// The control for test 1: in the person's own brand the same routes are neither 401 nor 404, and none fails.
export async function ownBrandFindings(
  routes: readonly ProbeRoute[],
  request: ProbeRequest,
  fill: (path: string) => string,
): Promise<string[]> {
  const findings: string[] = []
  for (const route of routes) {
    const reply = await request(route.method.toUpperCase(), `/api/v1${fill(route.path)}`, bodyFor(route))
    if (reply.status === 401 || reply.status === 404 || reply.status >= 500) {
      findings.push(`${route.method} ${route.path}: ${reply.status} in the person's own brand`)
    }
  }
  return findings
}

// A worker-route call carrying an attempt token.
export type TokenRequest = (path: string, token: string) => Promise<ProbeReply>

// Test 6: the token for `own` reads its own job's control, and is refused (403, not naming `otherBrand`) for
// every other job, in the same brand or another.
export async function attemptTokenFindings(
  request: TokenRequest,
  token: string,
  own: string,
  others: readonly { jobId: string; label: string }[],
  otherBrand: string,
): Promise<string[]> {
  const findings: string[] = []
  const mine = await request(`/api/v1/worker/jobs/${own}/control`, token)
  if (mine.status !== 200) findings.push(`own job's control: ${mine.status}, not 200`)
  for (const other of others) {
    const reply = await request(`/api/v1/worker/jobs/${other.jobId}/control`, token)
    if (reply.status !== 403) findings.push(`${other.label}: ${reply.status}, not 403`)
    else if (reply.text.includes(otherBrand)) findings.push(`${other.label}: the refusal names the brand`)
  }
  return findings
}
