// What the specs use to reach the stack (stack.ts) and to drive the sign-in screens. Plain fetch and Playwright
// only: a spec process loads nothing from the core.
import { expect, type Page } from '@playwright/test'

export const PASSWORD = 'correct horse battery'

const dashboardPort = Number(process.env.E2E_PORT ?? 3410)
const controlUrl = `http://127.0.0.1:${dashboardPort + 1}`

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${controlUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(`${path}: ${json.error ?? res.status}`)
  return json
}

let counter = 0
// A name no other spec, and no earlier run of the same spec in this stack, uses.
export function unique(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}${counter}`
}

export const makeBrand = async (slug: string): Promise<string> =>
  (await call<{ brandId: string }>('POST', '/brand', { slug })).brandId

export interface TestUser {
  email: string
  secret: string | null
}

export async function makeUser(options: {
  email: string
  role?: 'brand_admin' | 'approver' | 'sales_contact' | 'viewer'
  brandId?: string
  platformOwner?: boolean
  enrolled?: boolean
}): Promise<TestUser> {
  const made = await call<{ secret: string | null }>('POST', '/user', options)
  return { email: options.email, secret: made.secret }
}

export const makeItem = (brandId: string, title: string) =>
  call<{ itemId: string; versionId: string }>('POST', '/item', { brandId, title })

// Moves the platform's clock forward and runs the approvals' reminders for each day (see stack.ts).
export const advanceClock = (hours: number) => call('POST', '/clock', { hours })

export const expireSessions = (email: string) => call('POST', '/expire-sessions', { email })

export async function codeFor(secret: string): Promise<string> {
  return (await call<{ code: string }>('POST', '/code', { secret })).code
}

// Signs in through the screens. A person with a second factor (`secret`) types the code on the next screen.
// Resolves once the browser has left the sign-in screens.
export async function signIn(page: Page, user: TestUser, from = '/sign-in'): Promise<void> {
  await page.goto(from)
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  if (user.secret) {
    await page.waitForURL(/\/sign-in\/verify/)
    await page.getByLabel('6-digit code').fill(await codeFor(user.secret))
    await page.getByRole('button', { name: 'Verify' }).click()
  }
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'))
}

// The kill switch, overdue pop-up and every other screen must fit a phone: the page is no wider than the window.
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    window: window.innerWidth,
  }))
  expect(widths.page, 'the page scrolls sideways').toBeLessThanOrEqual(widths.window)
}

// Asks the overdue watcher to read now (it also does so every 60 seconds and when the window is focused).
export async function pollOverdueNow(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}
