import { expect, test } from '@playwright/test'
import { totp } from '../../../packages/test-support/src/totp.ts'

// The browser suite against a deployed origin (plan Task 12, step 2): read-only checks with the restore drill's
// user (docs/operations.md, "Restore drill"), a brand admin of restore-drill-a only, with a second factor.
// Runs only when E2E_BASE_URL is set (playwright.config.ts then starts no stack and runs only this file).
// The user comes from RESTORE_DRILL_EMAIL, RESTORE_DRILL_PASSWORD and RESTORE_DRILL_TOTP_SECRET in the
// environment (the drill file), never from the command line, and is never printed.
// Side effects: one failed sign-in and one session for the drill user, both in the audit log as usual.
const deployed = !!process.env.E2E_BASE_URL
const email = process.env.RESTORE_DRILL_EMAIL ?? ''
const password = process.env.RESTORE_DRILL_PASSWORD ?? ''
const secret = process.env.RESTORE_DRILL_TOTP_SECRET ?? ''

test.describe('deployed origin', () => {
  test.skip(!deployed, 'E2E_BASE_URL is not set')
  test.beforeAll(() => {
    if (!email || !password || !secret)
      throw new Error('RESTORE_DRILL_EMAIL, _PASSWORD and _TOTP_SECRET are required')
  })

  test('the sign-in page is served with the security headers', async ({ page }) => {
    const reply = await page.goto('/sign-in')
    expect(reply?.status()).toBe(200)
    const headers = reply?.headers() ?? {}
    expect(headers['strict-transport-security']).toMatch(/max-age=\d+/)
    expect(headers['cross-origin-opener-policy']).toBe('same-origin')
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  })

  test('a wrong password is refused and gives no session', async ({ page }) => {
    await page.goto('/sign-in')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(`${password}-wrong`)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/sign-in/)
    const session = await page.request.get('/api/v1/session')
    expect(session.status()).toBe(401)
  })

  test('the drill user signs in with the second factor, sees only their brand, and signs out', async ({
    page,
  }) => {
    await page.goto('/sign-in')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(/\/sign-in\/verify/)
    await page.getByLabel('6-digit code').fill(totp(secret))
    await page.getByRole('button', { name: 'Verify' }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'))
    await expect(page).not.toHaveURL(/\/enrol$/)

    // Exactly one brand, the drill's own: the other drill brand and every real brand stay out of sight.
    const brands = await page.request.get('/api/v1/brands')
    expect(brands.status()).toBe(200)
    const { brands: rows } = (await brands.json()) as { brands: { id: string; slug: string }[] }
    expect(rows.map((b) => b.slug)).toEqual(['restore-drill-a'])

    // A member of one brand lands on that brand; its approval inbox opens.
    await page.goto(`/b/${rows[0]?.id}/inbox`)
    await expect(page.getByRole('heading', { name: 'Approval inbox', level: 1 })).toBeVisible()

    await page.getByRole('button', { name: 'Sign out' }).first().click()
    await page.waitForURL(/\/sign-in/)
    const after = await page.request.get('/api/v1/session')
    expect(after.status()).toBe(401)
  })
})
