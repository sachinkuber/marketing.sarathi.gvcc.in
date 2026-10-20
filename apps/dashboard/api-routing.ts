// How /api reaches the core, decided when the config loads.
//
// Next.js compiles rewrites into the build, so the core address is fixed by `next build`, not by `next start`.
// A production build therefore has to say how /api is routed, or the bundle silently has no /api route and
// every call answers Next's own 404:
//   - CORE_INTERNAL_URL=http://host:port   the build rewrites /api/* to the core (development, e2e, no proxy), or
//   - DASHBOARD_PROXY_ROUTES_API=1         a reverse proxy in front sends /api/* to the core (production).
// `next dev` needs CORE_INTERNAL_URL. A bad address is refused in every phase.
const BUILD = 'phase-production-build'
const DEV = 'phase-development-server'

export function apiRouting(phase: string, env: Record<string, string | undefined>): { core: string | null } {
  const core = env.CORE_INTERNAL_URL
  if (core !== undefined && core !== '') {
    if (!/^https?:\/\/[^/\s]+$/.test(core)) {
      throw new Error(
        'CORE_INTERNAL_URL must be an http(s) address with no path, for example http://core:3000.',
      )
    }
    return { core }
  }
  if (phase === DEV) {
    throw new Error(
      'CORE_INTERNAL_URL is not set: it is the core API address the dashboard forwards /api to.',
    )
  }
  if (phase === BUILD) {
    const flag = env.DASHBOARD_PROXY_ROUTES_API
    if (flag === '1') return { core: null }
    if (flag !== undefined && flag !== '') throw new Error('DASHBOARD_PROXY_ROUTES_API must be 1 or unset.')
    throw new Error(
      'This build does not say how /api reaches the core. Set CORE_INTERNAL_URL (the build rewrites /api to it) ' +
        'or DASHBOARD_PROXY_ROUTES_API=1 (a reverse proxy routes /api).',
    )
  }
  return { core: null }
}
