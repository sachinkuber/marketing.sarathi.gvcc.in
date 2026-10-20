import type { NextConfig } from 'next'
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants'

// The Content-Security-Policy is set per request by src/proxy.ts (it carries a nonce, so it cannot be a
// static header). The other security headers are static and set here.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
]

export default function config(phase: string): NextConfig {
  const core = process.env.CORE_INTERNAL_URL
  // In development the /api rewrite is the only way to the core, so it must be set. A production build does
  // not need it: the reverse proxy sends /api to the core there (plan decision 1).
  if (!core && phase === PHASE_DEVELOPMENT_SERVER) {
    throw new Error(
      'CORE_INTERNAL_URL is not set: it is the core API address the dashboard forwards /api to.',
    )
  }
  if (core && !/^https?:\/\/[^/\s]+$/.test(core)) {
    throw new Error(
      'CORE_INTERNAL_URL must be an http(s) address with no path, for example http://core:3000.',
    )
  }
  return {
    output: 'standalone',
    poweredByHeader: false,
    reactStrictMode: true,
    async rewrites() {
      return core ? [{ source: '/api/:path*', destination: `${core}/api/:path*` }] : []
    },
    async headers() {
      return [{ source: '/:path*', headers: securityHeaders }]
    },
  }
}
