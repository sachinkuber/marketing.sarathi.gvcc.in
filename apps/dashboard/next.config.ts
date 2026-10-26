import type { NextConfig } from 'next'
import { apiRouting } from './api-routing'

// How this app is configured, and what has to be decided when it is built.
//
// - /api: the dashboard calls the core only through /api on its own origin. Next.js compiles the rewrite into
//   the build, so `next build` must be told how /api is routed, with the core's final address:
//     CORE_INTERNAL_URL=http://core:3000 next build        (development, e2e: the build rewrites /api to the core)
//     DASHBOARD_PROXY_ROUTES_API=1 next build              (production: a reverse proxy routes /api to the core)
//   A build with neither is refused (see api-routing.ts), because it would answer every /api call with a 404.
// - Content-Security-Policy: set per request, with a nonce, by src/proxy.ts. The static headers are below.
//   HSTS and Cross-Origin-Opener-Policy belong to the TLS reverse proxy (package 16), not to this app.
// - Pages that carry a one-use token in the address (recovery, invite) send no Referer at all.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
]

export default function config(phase: string): NextConfig {
  const { core } = apiRouting(phase, process.env)
  return {
    output: 'standalone',
    poweredByHeader: false,
    reactStrictMode: true,
    async rewrites() {
      return core ? [{ source: '/api/:path*', destination: `${core}/api/:path*` }] : []
    },
    async headers() {
      return [
        { source: '/:path*', headers: securityHeaders },
        {
          source: '/:path((?!reset-password|accept-invite|invite).*)',
          headers: [{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }],
        },
        ...['/reset-password', '/accept-invite', '/invite/:token'].map((source) => ({
          source,
          headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
        })),
      ]
    },
  }
}
