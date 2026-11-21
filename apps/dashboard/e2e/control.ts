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
  // A phone browser that finds the page too wide shows it zoomed out, so the window itself grows: the window
  // must stay as wide as the screen.
  expect(widths.window, 'the page is wider than the screen').toBeLessThanOrEqual(page.viewportSize()!.width)
}

// Asks the overdue watcher to read now (it also does so every 60 seconds and when the window is focused).
export async function pollOverdueNow(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}

// A one-page PDF, made here so no file sits in the repo: the five objects and a cross-reference table with
// the real offsets, so the core's page count and the model's document part both read it.
export function tinyPdf(text = 'Our coatings are ISO 9001 certified.'): Buffer {
  const stream = `BT /F1 18 Tf 20 150 Td (${text.replace(/[()\\]/g, '')}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
