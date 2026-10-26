import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { contentSecurityPolicy } from './csp'

// Runs before every page request: a fresh nonce, the policy that carries it, and the same policy on the
// request so Next.js puts the nonce on its scripts. Pages are therefore rendered per request (see layout.tsx).
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID())
  const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV === 'development')
  const headers = new Headers(request.headers)
  headers.set('x-nonce', nonce)
  headers.set('Content-Security-Policy', policy)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set('Content-Security-Policy', policy)
  return response
}

export const config = {
  matcher: [
    {
      source: '/((?!api/|api$|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
