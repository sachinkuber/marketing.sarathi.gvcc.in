import type { z } from 'zod'
import { sessionReply } from './schemas'

// The dashboard's only way to the platform: the core's HTTP API on this same origin. It carries the session
// cookie (same-origin) and, on every write, the request token from `GET /api/v1/session`.

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

const API = '/api/v1'

let csrfToken: string | null = null

export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

export function cachedCsrfToken(): string | null {
  return csrfToken
}

// Where a sign-in may send a person afterwards: a path on this site, nothing else. Anything that could name
// another host ("//evil", "/\evil", "https://evil", "javascript:...") falls back to the front page.
export function safeNext(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  if ([...raw].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f || ch === '\\')) return '/'
  try {
    const parsed = new URL(raw, 'http://same-origin.invalid')
    if (parsed.origin !== 'http://same-origin.invalid') return '/'
  } catch {
    return '/'
  }
  return raw
}

const AUTH_PAGES = ['/sign-in', '/enrol', '/recover', '/reset-password', '/invite', '/accept-invite']

function onAuthPage(path: string): boolean {
  return AUTH_PAGES.some(
    (page) => path === page || path.startsWith(`${page}/`) || path.startsWith(`${page}?`),
  )
}

function navigate(url: string): void {
  if (typeof window !== 'undefined') window.location.assign(url)
}

function currentPath(): string {
  if (typeof window === 'undefined') return '/'
  return `${window.location.pathname}${window.location.search}`
}

// The address of the sign-in screen that returns to the current place afterwards.
export function signInAddress(path: string = currentPath()): string {
  if (onAuthPage(path)) return '/sign-in'
  const next = safeNext(path)
  return next === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`
}

interface RawReply {
  status: number
  json: unknown
}

// The core's errors are { error: { code, message } }; the sign-in library's are { code, message }.
function errorOf(json: unknown): { code: string; message: string } {
  const body = json as {
    error?: { code?: unknown; message?: unknown }
    code?: unknown
    message?: unknown
  } | null
  const error = body?.error ?? body
  return {
    code: typeof error?.code === 'string' ? error.code : 'error',
    message: typeof error?.message === 'string' ? error.message : 'The request failed.',
  }
}

async function send(method: string, url: string, body: unknown, token: string | null): Promise<RawReply> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers['x-csrf-token'] = token
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network', 'The platform could not be reached.')
  }
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json }
}

async function tokenForWrite(): Promise<string> {
  if (csrfToken) return csrfToken
  const reply = await send('GET', `${API}/session`, undefined, null)
  const parsed = sessionReply.safeParse(reply.json)
  if (reply.status === 401) {
    navigate(signInAddress())
    throw new ApiError(401, errorOf(reply.json).code, errorOf(reply.json).message)
  }
  if (!parsed.success)
    throw new ApiError(reply.status, 'bad_reply', 'The platform sent a reply this page cannot read.')
  csrfToken = parsed.data.csrfToken
  return csrfToken
}

// Calls a core route and parses the reply with `schema`; a reply that does not fit is an error, never data.
// 401 sends the person to sign in and back; 403 enrolment_required sends them to set up their second factor.
export async function api<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown): Promise<T> {
  const verb = method.toUpperCase()
  const write = verb !== 'GET'
  let reply = await send(verb, `${API}${path}`, body, write ? await tokenForWrite() : null)
  if (write && reply.status === 403 && errorOf(reply.json).code === 'bad_csrf_token') {
    // The session changed under a cached token: fetch a fresh one and try once more.
    csrfToken = null
    reply = await send(verb, `${API}${path}`, body, await tokenForWrite())
  }
  if (reply.status === 401) {
    const { code, message } = errorOf(reply.json)
    navigate(signInAddress())
    throw new ApiError(401, code, message)
  }
  if (reply.status < 200 || reply.status >= 300) {
    const { code, message } = errorOf(reply.json)
    if (reply.status === 403 && code === 'enrolment_required') navigate('/enrol')
    throw new ApiError(reply.status, code, message)
  }
  const parsed = schema.safeParse(reply.json)
  if (!parsed.success) {
    throw new ApiError(reply.status, 'bad_reply', 'The platform sent a reply this page cannot read.')
  }
  return parsed.data
}

// The library's own routes under /api/auth (sign-in, second factor, recovery). A signed-in person's write
// carries the request token like any other; before sign-in there is none to send.
export async function authCall<T>(
  schema: z.ZodType<T>,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const reply = await send(method.toUpperCase(), `/api/auth${path}`, body ?? {}, csrfToken)
  if (reply.status < 200 || reply.status >= 300) {
    const { code, message } = errorOf(reply.json)
    throw new ApiError(reply.status, code, message)
  }
  const parsed = schema.safeParse(reply.json)
  if (!parsed.success) {
    throw new ApiError(reply.status, 'bad_reply', 'The platform sent a reply this page cannot read.')
  }
  return parsed.data
}

// A core route that needs no session (invite lookup and accept): no request token, and a 401 is just an error.
export async function publicApi<T>(
  schema: z.ZodType<T>,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const reply = await send(method.toUpperCase(), `${API}${path}`, body, null)
  if (reply.status < 200 || reply.status >= 300) {
    const { code, message } = errorOf(reply.json)
    throw new ApiError(reply.status, code, message)
  }
  const parsed = schema.safeParse(reply.json)
  if (!parsed.success) {
    throw new ApiError(reply.status, 'bad_reply', 'The platform sent a reply this page cannot read.')
  }
  return parsed.data
}
